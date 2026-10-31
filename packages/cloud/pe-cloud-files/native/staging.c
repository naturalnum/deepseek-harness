/* Private Linux staging ABI1 companion. No env instance_data; one FD transaction per addon environment. */
#define _GNU_SOURCE
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <linux/openat2.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

typedef struct {
  int dirs[4], file;
  struct stat directory[4], identity;
  int created[4], existing, eof, temporary, publication, unknown, close_unknown;
  uint64_t mount, maximum, expected, chunk, written, read, sequence, deadline;
  char *root, *name;
  char digest[65], temp[64];
  int32_t *cancel;
  napi_ref cancel_ref;
} stage;
typedef struct {
  stage tx;
  uint64_t generation;
  unsigned references;
  int active, poisoned, closing;
  napi_env env;
} owner;
typedef struct { owner *parent; uint64_t generation; } handle;
_Static_assert(sizeof(owner) + sizeof(handle) <= 2048, "staging ABI1 native control allocations must remain bounded");
static const napi_type_tag tag = { UINT64_C(0x63a217ff981e45c3), UINT64_C(0xad19532fbce01801) };

static uint64_t milliseconds(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now)) return 0;
  return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
}
static int pending(stage *s) {
  if (__atomic_load_n(s->cancel, __ATOMIC_SEQ_CST)) return ECANCELED;
  uint64_t now = milliseconds();
  return !now || now >= s->deadline ? ETIMEDOUT : 0;
}
static int mounted(int fd, uint64_t mount) {
  struct statx st;
  if (statx(fd, "", AT_EMPTY_PATH | AT_STATX_SYNC_AS_STAT, STATX_MNT_ID, &st)) return errno;
  if (!(st.stx_mask & STATX_MNT_ID)) return EOPNOTSUPP;
  return st.stx_mnt_id == mount ? 0 : EXDEV;
}
static int same(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino && (a->st_mode & S_IFMT) == (b->st_mode & S_IFMT);
}
static int unchanged(const struct stat *a, const struct stat *b) {
  return same(a, b) && a->st_size == b->st_size && a->st_nlink == b->st_nlink
    && a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec
    && a->st_ctim.tv_sec == b->st_ctim.tv_sec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
}
static int below(int dir, const char *name, int flags, mode_t mode) {
  struct open_how how = { .flags = (uint64_t)(flags | O_CLOEXEC | O_NOFOLLOW | ((flags & O_PATH) ? 0 : O_NONBLOCK)), .mode = mode,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV | RESOLVE_NO_SYMLINKS };
  return (int)syscall(SYS_openat2, dir, name, &how, sizeof(how));
}
static int definite_no_create(int error) {
  /* Only the approved isolated local backend uses this syscall-result allowlist. */
  return error == EPERM || error == EACCES || error == EEXIST || error == ENOTDIR || error == EINVAL
    || error == ENOSPC || error == EROFS || error == ENAMETOOLONG || error == EDQUOT;
}

static void close_fd(stage *s, int *fd) {
  if (*fd < 0) return;
  int value = *fd;
  *fd = -1; /* Never retry close: a failed close cannot authorize closing a recycled descriptor. */
  if (close(value)) s->unknown = s->close_unknown = 1;
}
static int sync_fd(stage *s, int fd) {
  if (!fsync(fd)) return 0;
  s->unknown = 1;
  return errno;
}
static const char *directory_name(stage *s, int index) {
  return index == 1 ? ".pe" : index == 2 ? "attachments" : s->digest;
}
static int chain(stage *s) {
  struct stat observed;
  int root = open(s->root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (root < 0) return errno;
  int error = fstat(root, &observed) ? errno : !same(&observed, &s->directory[0]) ? ESTALE : mounted(root, s->mount);
  close_fd(s, &root);
  if (s->unknown) return EIO;
  if (error) return error;
  for (int i = 0; i < 4; i++) {
    if (s->dirs[i] < 0) break;
    if (fstat(s->dirs[i], &observed)) return errno;
    if (!same(&observed, &s->directory[i])) return ESTALE;
    if (i) {
      int named = below(s->dirs[i - 1], directory_name(s, i), O_RDONLY | O_DIRECTORY, 0);
      if (named < 0) return errno;
      error = fstat(named, &observed) ? errno : !same(&observed, &s->directory[i]) ? ESTALE : mounted(named, s->mount);
      close_fd(s, &named);
      if (s->unknown) return EIO;
      if (error) return error;
    }
  }
  return 0;
}
static int regular(stage *s, int fd, struct stat *st) {
  if (fstat(fd, st)) return errno;
  if (!S_ISREG(st->st_mode) || st->st_nlink != 1) return EPERM;
  if (st->st_size < 0 || (uint64_t)st->st_size > s->maximum) return EFBIG;
  return mounted(fd, s->mount);
}
static int leaf_identity(stage *s, const char *name) {
  struct stat st, current;
  int error = regular(s, s->file, &current);
  if (error) return error;
  if (!same(&current, &s->identity)) return ESTALE;
  int named = below(s->dirs[3], name, O_PATH, 0);
  if (named < 0) return errno;
  error = fstat(named, &st) ? errno : !same(&current, &st) || st.st_nlink != 1 ? ESTALE : mounted(named, s->mount);
  close_fd(s, &named);
  return s->unknown ? EIO : error;
}
static void remove_temp(stage *s) {
  if (!s->temporary) return;
  struct stat st;
  if (s->dirs[3] < 0 || fstatat(s->dirs[3], s->temp, &st, AT_SYMLINK_NOFOLLOW)
    || !same(&st, &s->identity) || st.st_nlink != 1) { s->unknown = 1; return; }
  if (unlinkat(s->dirs[3], s->temp, 0)) { s->unknown = 1; return; }
  s->temporary = 0;
  (void)sync_fd(s, s->dirs[3]);
}
static void cleanup(owner *o, int rollback) {
  stage *s = &o->tx;
  if (rollback) remove_temp(s);
  close_fd(s, &s->file);
  if (rollback && s->publication == 0) {
    for (int i = 3; i > 0; i--) {
      if (s->created[i] && s->dirs[i] < 0) { s->unknown = 1; continue; }
      if (!s->created[i] || s->dirs[i] < 0 || s->dirs[i - 1] < 0) continue;
      struct stat current;
      if (fstatat(s->dirs[i - 1], directory_name(s, i), &current, AT_SYMLINK_NOFOLLOW)
        || !same(&current, &s->directory[i])) { s->unknown = 1; continue; }
      if (!unlinkat(s->dirs[i - 1], directory_name(s, i), AT_REMOVEDIR)) {
        s->created[i] = 0;
        (void)sync_fd(s, s->dirs[i - 1]);
      } else if (errno != ENOTEMPTY && errno != EEXIST) s->unknown = 1;
    }
  }
  for (int i = 3; i >= 0; i--) close_fd(s, &s->dirs[i]);
  if (s->cancel_ref) { napi_delete_reference(o->env, s->cancel_ref); s->cancel_ref = NULL; }
  free(s->root); free(s->name); s->root = s->name = NULL;
  o->active = 0;
  if (s->unknown) o->poisoned = 1;
}
static void release(owner *o) { if (!--o->references) free(o); }
static void environment_cleanup(void *data) {
  owner *o = data;
  o->closing = 1;
  if (o->active) cleanup(o, 1);
  release(o); /* Termination has no clean receipt; its caller must still retain unknown responsibility. */
}
static void handle_cleanup(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  handle *h = data;
  owner *o = h->parent;
  if (!o->closing && o->active && o->generation == h->generation) cleanup(o, 1);
  release(o); free(h);
}
static const char *code(int error) {
  switch (error) {
    case 0: return "OK"; case EINVAL: return "EINVAL"; case EBUSY: return "EBUSY";
    case ENOENT: return "ENOENT"; case EEXIST: return "EEXIST"; case ELOOP: return "ELOOP";
    case EXDEV: return "EXDEV"; case ESTALE: return "ESTALE"; case ENOTDIR: return "ENOTDIR";
    case EPERM: return "EPERM"; case EACCES: return "EACCES"; case EFBIG: return "EFBIG";
    case ECANCELED: return "ECANCELED"; case ETIMEDOUT: return "ETIMEDOUT";
    case ENOSPC: return "ENOSPC"; case EDQUOT: return "EDQUOT"; case ENOSYS: return "ENOSYS";
    default: return "EIO";
  }
}
static napi_value thrown(napi_env env, int error) {
  napi_throw_error(env, code(error), "Private staging ABI1 operation rejected"); return NULL;
}
static void string_property(napi_env env, napi_value result, const char *key, const char *value) {
  napi_value item; napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &item); napi_set_named_property(env, result, key, item);
}
static void boolean_property(napi_env env, napi_value result, const char *key, int value) {
  napi_value item; napi_get_boolean(env, value, &item); napi_set_named_property(env, result, key, item);
}
static void number_property(napi_env env, napi_value result, const char *key, uint64_t value) {
  napi_value item; napi_create_double(env, (double)value, &item); napi_set_named_property(env, result, key, item);
}
static napi_value facts(napi_env env, owner *o, const char *kind, int error) {
  stage *s = &o->tx;
  napi_value result; napi_create_object(env, &result);
  string_property(env, result, "kind", s->unknown ? "unknown" : kind);
  string_property(env, result, "code", s->unknown && !error ? "STAGING_SETTLEMENT_UNKNOWN" : code(error));
  string_property(env, result, "publication", s->publication == 2 ? "unknown" : s->publication ? "published" : "none");
  boolean_property(env, result, "closed", !o->active && !s->close_unknown);
  boolean_property(env, result, "clean", !o->active && !s->unknown && !s->temporary);
  boolean_property(env, result, "temporaryPresent", s->temporary);
  number_property(env, result, "writtenBytes", s->written);
  number_property(env, result, "readBytes", s->read);
  number_property(env, result, "sequence", s->sequence);
  unsigned retained = 0; for (int i = 1; i < 4; i++) retained += !!s->created[i];
  number_property(env, result, "retainedCreatedDirectories", retained);
  return result;
}
static napi_value failed(napi_env env, owner *o, int error) {
  cleanup(o, 1); return facts(env, o, "failed", error);
}
static int property(napi_env env, napi_value object, const char *key, napi_value *result) {
  return napi_get_named_property(env, object, key, result) == napi_ok;
}
static char *text(napi_env env, napi_value value, size_t maximum) {
  size_t size = 0, actual = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &size) != napi_ok || !size || size > maximum) return NULL;
  char *result = malloc(size + 1);
  if (!result) return NULL;
  if (napi_get_value_string_utf8(env, value, result, size + 1, &actual) != napi_ok || actual != size || strlen(result) != size) {
    free(result); return NULL;
  }
  return result;
}
static int integer(napi_env env, napi_value value, uint64_t maximum, uint64_t *result) {
  double number;
  if (napi_get_value_double(env, value, &number) != napi_ok || !(number >= 0 && number <= (double)maximum)) return 0;
  *result = (uint64_t)number; return (double)*result == number;
}
static int number_option(napi_env env, napi_value object, const char *key, uint64_t maximum, uint64_t *result) {
  napi_value value; return property(env, object, key, &value) && integer(env, value, maximum, result);
}
static int decimal_option(napi_env env, napi_value object, const char *key, uint64_t *result) {
  napi_value value;
  if (!property(env, object, key, &value)) return 0;
  char *source = text(env, value, 20);
  if (!source) return 0;
  int valid = source[0] != '0' || source[1] == 0;
  for (char *p = source; *p; p++) if (*p < '0' || *p > '9') valid = 0;
  char *end; errno = 0; unsigned long long number = strtoull(source, &end, 10);
  valid = valid && !errno && !*end; free(source);
  if (valid) *result = (uint64_t)number;
  return valid;
}
static int whitespace(uint32_t c) {
  return c == 0x20 || c == 0xa0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200a)
    || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;
}
static int safe_name(const char *name) {
  size_t size = strlen(name);
  if (!size || size > 255 || !strcmp(name, ".") || !strcmp(name, "..") || name[size - 1] == '.') return 0;
  const unsigned char *p = (const unsigned char *)name;
  uint32_t first = 0, last = 0;
  while (*p) {
    uint32_t c = *p++; unsigned following = 0; uint32_t minimum = 0;
    if (c >= 0xc2 && c <= 0xdf) { c &= 31; following = 1; minimum = 0x80; }
    else if (c >= 0xe0 && c <= 0xef) { c &= 15; following = 2; minimum = 0x800; }
    else if (c >= 0xf0 && c <= 0xf4) { c &= 7; following = 3; minimum = 0x10000; }
    else if (c >= 0x80) return 0;
    for (unsigned i = 0; i < following; i++) { if ((*p & 0xc0) != 0x80) return 0; c = (c << 6) | (*p++ & 63); }
    if (c < minimum || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff) || c < 32 || c == 127
      || (c < 128 && strchr("/\\<>:\"|?*", (int)c))) return 0;
    if (!first) first = c;
    last = c;
  }
  if (whitespace(first) || whitespace(last)) return 0;
  size_t stem = strcspn(name, ".");
  while (stem && (name[stem - 1] == '.' || name[stem - 1] == ' ')) stem--;
  if (stem == 3 && (!strncasecmp(name, "con", 3) || !strncasecmp(name, "prn", 3)
    || !strncasecmp(name, "aux", 3) || !strncasecmp(name, "nul", 3))) return 0;
  if (stem == 4 && (!strncasecmp(name, "com", 3) || !strncasecmp(name, "lpt", 3)) && name[3] >= '1' && name[3] <= '9') return 0;
  return 1;
}
static owner *callback(napi_env env, napi_callback_info info, size_t *count, napi_value *args) {
  void *data = NULL;
  if (napi_get_cb_info(env, info, count, args, NULL, &data) != napi_ok) return NULL;
  return data;
}
static stage *transaction(napi_env env, owner *o, napi_value value) {
  bool matched = false; handle *h = NULL;
  if (!o || !o->active || napi_check_object_type_tag(env, value, &tag, &matched) != napi_ok || !matched
    || napi_unwrap(env, value, (void **)&h) != napi_ok || !h || h->parent != o || h->generation != o->generation) return NULL;
  return &o->tx;
}
static int open_existing(stage *s) {
  int fd = below(s->dirs[3], s->name, O_RDONLY, 0);
  if (fd < 0) return errno;
  s->file = fd;
  int error = regular(s, fd, &s->identity);
  if (error) return error;
  if ((uint64_t)s->identity.st_size != s->expected) return EFBIG;
  s->existing = 1; s->read = s->sequence = 0; s->eof = 0;
  return leaf_identity(s, s->name);
}
static napi_value begin(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1], value;
  owner *o = callback(env, info, &argc, args);
  if (!o || argc != 1 || o->active || o->poisoned) return thrown(env, EBUSY);
  stage *s = &o->tx; memset(s, 0, sizeof(*s));
  for (int i = 0; i < 4; i++) s->dirs[i] = -1;
  s->file = -1;
  uint64_t device, inode, path_maximum, timeout;
  if (!number_option(env, args[0], "maxPathBytes", 16384, &path_maximum) || !path_maximum
    || !number_option(env, args[0], "maxBytes", UINT64_C(9007199254740991), &s->maximum) || !s->maximum
    || !number_option(env, args[0], "expectedBytes", s->maximum, &s->expected)
    || !number_option(env, args[0], "maxChunkBytes", INT32_MAX, &s->chunk) || !s->chunk || s->chunk > s->maximum
    || !number_option(env, args[0], "timeoutMs", INT32_MAX, &timeout) || !timeout
    || !decimal_option(env, args[0], "device", &device) || !decimal_option(env, args[0], "inode", &inode)
    || !decimal_option(env, args[0], "mountId", &s->mount) || !s->mount) return thrown(env, EINVAL);
  if (!property(env, args[0], "rootPath", &value) || !(s->root = text(env, value, path_maximum))
    || !property(env, args[0], "name", &value) || !(s->name = text(env, value, path_maximum < 255 ? path_maximum : 255))) goto invalid;
  if (s->root[0] != '/' || !safe_name(s->name) || strlen(s->root) + strlen(s->name) + 83 > path_maximum) goto invalid;
  if (!property(env, args[0], "digest", &value)) goto invalid;
  char *digest = text(env, value, 64);
  if (!digest) goto invalid;
  int valid = strlen(digest) == 64 && strspn(digest, "0123456789abcdef") == 64;
  if (valid) memcpy(s->digest, digest, 65);
  free(digest);
  if (!valid || !property(env, args[0], "cancel", &value)) goto invalid;
  napi_typedarray_type type; size_t length, offset; void *data; napi_value buffer;
  if (napi_get_typedarray_info(env, value, &type, &length, &data, &buffer, &offset) != napi_ok
    || type != napi_int32_array || length != 1 || offset != 0 || !data) goto invalid;
  bool ordinary_buffer = false;
  if (napi_is_arraybuffer(env, buffer, &ordinary_buffer) != napi_ok || ordinary_buffer) goto invalid;
  if (napi_create_reference(env, value, 1, &s->cancel_ref) != napi_ok) goto invalid;
  s->cancel = data; s->deadline = milliseconds() + timeout; o->active = 1; o->generation++;
  int error = pending(s);
  if (error) return failed(env, o, error);
  s->dirs[0] = open(s->root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (s->dirs[0] < 0) return failed(env, o, errno);
  if (fstat(s->dirs[0], &s->directory[0])) return failed(env, o, errno);
  if ((uint64_t)s->directory[0].st_dev != device || (uint64_t)s->directory[0].st_ino != inode) return failed(env, o, ESTALE);
  if ((error = mounted(s->dirs[0], s->mount))) return failed(env, o, error);
  for (int i = 1; i < 4; i++) {
    if ((error = pending(s)) || (error = chain(s))) return failed(env, o, error);
    const char *name = directory_name(s, i);
    s->dirs[i] = below(s->dirs[i - 1], name, O_RDONLY | O_DIRECTORY, 0);
    if (s->dirs[i] < 0 && errno == ENOENT) {
      if (!mkdirat(s->dirs[i - 1], name, 0700)) s->created[i] = 1;
      else if (errno != EEXIST) return failed(env, o, errno);
      s->dirs[i] = below(s->dirs[i - 1], name, O_RDONLY | O_DIRECTORY, 0);
    }
    if (s->dirs[i] < 0) return failed(env, o, errno);
    if (fstat(s->dirs[i], &s->directory[i])) return failed(env, o, errno);
    if ((error = mounted(s->dirs[i], s->mount))) return failed(env, o, error);
    if (s->created[i] && (error = sync_fd(s, s->dirs[i - 1]))) return failed(env, o, error);
  }
  if ((error = chain(s))) return failed(env, o, error);
  error = open_existing(s);
  if (error == ENOENT && s->file >= 0) return failed(env, o, ESTALE);
  if (error != ENOENT && error) return failed(env, o, error);
  if (error == ENOENT) {
    unsigned char random[16];
    if (getrandom(random, sizeof(random), 0) != (ssize_t)sizeof(random)) return failed(env, o, EIO);
    memcpy(s->temp, ".stage-", 7);
    for (int i = 0; i < 16; i++) snprintf(s->temp + 7 + i * 2, 3, "%02x", random[i]);
    if (!strcmp(s->temp, s->name)) return failed(env, o, EINVAL);
    s->file = below(s->dirs[3], s->temp, O_RDWR | O_CREAT | O_EXCL, 0600);
    if (s->file < 0) {
      error = errno;
      if (!definite_no_create(error)) s->unknown = 1;
      return failed(env, o, error);
    }
    s->temporary = 1;
    if ((error = regular(s, s->file, &s->identity))) return failed(env, o, error);
  }
  handle *h = calloc(1, sizeof(*h));
  if (!h) return failed(env, o, ENOMEM);
  h->parent = o; h->generation = o->generation; o->references++;
  napi_value wrapped; napi_create_object(env, &wrapped);
  if (napi_type_tag_object(env, wrapped, &tag) != napi_ok || napi_wrap(env, wrapped, h, handle_cleanup, NULL, NULL) != napi_ok) {
    release(o); free(h); return failed(env, o, EIO);
  }
  napi_value result = facts(env, o, s->existing ? "existing" : "write", 0);
  napi_set_named_property(env, result, "handle", wrapped); return result;
invalid:
  free(s->root); free(s->name); s->root = s->name = NULL;
  return thrown(env, EINVAL);
}
static napi_value write_chunk(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value args[3]; owner *o = callback(env, info, &argc, args);
  stage *s = argc == 3 ? transaction(env, o, args[0]) : NULL;
  uint64_t sequence; napi_typedarray_type type; size_t length, offset; void *data; napi_value buffer;
  if (!s || s->existing || !integer(env, args[1], UINT64_C(9007199254740991), &sequence) || sequence != s->sequence
    || napi_get_typedarray_info(env, args[2], &type, &length, &data, &buffer, &offset) != napi_ok
    || type != napi_uint8_array || !length || length > s->chunk || (uint64_t)length > s->expected - s->written) return thrown(env, EINVAL);
  int error;
  if ((error = pending(s)) || (error = chain(s)) || (error = leaf_identity(s, s->temp))) return failed(env, o, error);
  size_t done = 0;
  while (done < length) {
    if ((error = pending(s))) return failed(env, o, error);
    ssize_t count = write(s->file, (char *)data + done, length - done);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return failed(env, o, count < 0 ? errno : EIO);
    done += (size_t)count; s->written += (uint64_t)count;
  }
  s->sequence++; return facts(env, o, "written", 0);
}
static napi_value read_existing(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value args[3]; owner *o = callback(env, info, &argc, args);
  stage *s = argc == 3 ? transaction(env, o, args[0]) : NULL;
  uint64_t sequence;
  napi_typedarray_type type; size_t maximum, offset; void *data; napi_value buffer; bool ordinary = false;
  if (!s || !s->existing || s->eof || !integer(env, args[1], UINT64_C(9007199254740991), &sequence) || sequence != s->sequence
    || napi_get_typedarray_info(env, args[2], &type, &maximum, &data, &buffer, &offset) != napi_ok
    || type != napi_uint8_array || !maximum || maximum > s->chunk || !data
    || napi_is_arraybuffer(env, buffer, &ordinary) != napi_ok || !ordinary) return thrown(env, EINVAL);
  int error;
  if ((error = pending(s)) || (error = chain(s)) || (error = leaf_identity(s, s->name))) return failed(env, o, error);
  uint64_t remaining_with_sentinel = s->expected - s->read + 1;
  if ((uint64_t)maximum > remaining_with_sentinel) maximum = (size_t)remaining_with_sentinel;
  ssize_t count;
  do { count = read(s->file, data, (size_t)maximum); } while (count < 0 && errno == EINTR && !(error = pending(s)));
  if (count < 0) return failed(env, o, errno);
  s->read += (uint64_t)count; s->sequence++;
  if (s->read > s->expected) return failed(env, o, EFBIG);
  if (!count) {
    struct stat current;
    s->eof = 1;
    error = regular(s, s->file, &current);
    if (!error && !unchanged(&current, &s->identity)) error = ESTALE;
    if (error) return failed(env, o, error);
  }
  napi_value result = facts(env, o, "existing-chunk", 0);
  number_property(env, result, "byteLength", (uint64_t)count); boolean_property(env, result, "eof", s->eof);
  return result;
}
static napi_value finalize(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; owner *o = callback(env, info, &argc, args);
  stage *s = argc == 1 ? transaction(env, o, args[0]) : NULL;
  if (!s || (s->existing ? !s->eof || s->read != s->expected : s->written != s->expected)) return thrown(env, EINVAL);
  int error;
  if ((error = pending(s)) || (error = chain(s)) || (error = leaf_identity(s, s->existing ? s->name : s->temp))) return failed(env, o, error);
  struct stat current;
  if ((error = regular(s, s->file, &current))) return failed(env, o, error);
  if ((uint64_t)current.st_size != s->expected || (s->existing && !unchanged(&current, &s->identity))) return failed(env, o, ESTALE);
  if ((error = sync_fd(s, s->file))) return failed(env, o, error);
  if (!s->existing) {
    if ((error = pending(s)) || (error = chain(s)) || (error = leaf_identity(s, s->temp))) return failed(env, o, error);
    if (syscall(SYS_renameat2, s->dirs[3], s->temp, s->dirs[3], s->name, RENAME_NOREPLACE)) {
      error = errno;
      if (error != EEXIST) { s->publication = 2; s->unknown = 1; return failed(env, o, error); }
      remove_temp(s); close_fd(s, &s->file);
      if (s->unknown) return failed(env, o, error);
      if ((error = chain(s)) || (error = open_existing(s))) return failed(env, o, error);
      return facts(env, o, "existing", EEXIST); /* Full EOF/hash revalidation is mandatory, never existence-as-success. */
    }
    s->temporary = 0; s->publication = 1;
  }
  for (int i = 3; i >= 0; i--) if ((error = sync_fd(s, s->dirs[i]))) return failed(env, o, error);
  if ((error = chain(s)) || (error = leaf_identity(s, s->name))) {
    if (s->publication) s->unknown = 1;
    return failed(env, o, error);
  }
  struct stat final;
  if ((error = regular(s, s->file, &final)) || (uint64_t)final.st_size != s->expected
    || final.st_mtim.tv_sec != current.st_mtim.tv_sec || final.st_mtim.tv_nsec != current.st_mtim.tv_nsec
    || (s->existing && !unchanged(&final, &s->identity))) {
    if (s->publication) s->unknown = 1;
    return failed(env, o, error ? error : ESTALE);
  }
  int reused = s->existing;
  cleanup(o, 0); return facts(env, o, reused ? "reused" : "published", 0);
}
static napi_value abort_stage(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; owner *o = callback(env, info, &argc, args);
  if (argc != 1 || !transaction(env, o, args[0])) return thrown(env, EINVAL);
  cleanup(o, 1); return facts(env, o, "aborted", 0);
}
static napi_value init(napi_env env, napi_value exports) {
  owner *o = calloc(1, sizeof(*o));
  if (!o) return thrown(env, ENOMEM);
  o->env = env; o->references = 1;
  if (napi_add_env_cleanup_hook(env, environment_cleanup, o) != napi_ok) { free(o); return thrown(env, EIO); }
  struct { const char *name; napi_callback fn; } methods[] = {
    { "begin", begin }, { "write", write_chunk }, { "readExisting", read_existing },
    { "finalize", finalize }, { "abort", abort_stage },
  };
  for (size_t i = 0; i < sizeof(methods) / sizeof(methods[0]); i++) {
    napi_value function; napi_create_function(env, methods[i].name, NAPI_AUTO_LENGTH, methods[i].fn, o, &function);
    napi_set_named_property(env, exports, methods[i].name, function);
  }
  number_property(env, exports, "stagingAbiVersion", 1);
  number_property(env, exports, "nativeControlBytes", sizeof(owner) + sizeof(handle));
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
