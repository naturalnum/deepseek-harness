/* Linux-only N-API helper. Each worker owns one anchor and one read/metadata/leaf descriptor. */
#define _GNU_SOURCE
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <linux/magic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <unistd.h>

typedef struct { int anchor; int reader; } owned_fds;

static napi_value fail(napi_env env, int error) {
  const char *code;
  switch (error) {
    case ENOENT: code = "ENOENT"; break;
    case ELOOP: code = "ELOOP"; break;
    case EXDEV: code = "EXDEV"; break;
    case EAGAIN: code = "EAGAIN"; break;
    case ENOTDIR: code = "ENOTDIR"; break;
    case EINVAL: code = "EINVAL"; break;
    case ESTALE: code = "ESTALE"; break;
    case ENOSYS: code = "ENOSYS"; break;
    case EACCES: code = "EACCES"; break;
    case EPERM: code = "EPERM"; break;
    case EDQUOT: code = "EDQUOT"; break;
    case ENOSPC: code = "ENOSPC"; break;
    case ENAMETOOLONG: code = "ENAMETOOLONG"; break;
    default: code = "EIO"; break;
  }
  napi_throw_error(env, code, "Linux FD operation failed");
  return NULL;
}

static owned_fds *state(napi_env env) {
  void *value = NULL;
  if (napi_get_instance_data(env, &value) != napi_ok) return NULL;
  return value;
}

static char *text(napi_env env, napi_value value) {
  size_t length = 0, actual = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length == 0 || length > 16384) return NULL;
  char *result = malloc(length + 1);
  if (!result) return NULL;
  if (napi_get_value_string_utf8(env, value, result, length + 1, &actual) != napi_ok || actual != length || strlen(result) != length) {
    free(result);
    return NULL;
  }
  return result;
}

static int decimal(napi_env env, napi_value value, uint64_t *result) {
  char *source = text(env, value);
  if (!source) return 0;
  for (char *p = source; *p; p++) {
    if (*p < '0' || *p > '9') { free(source); return 0; }
  }
  char *end;
  errno = 0;
  unsigned long long parsed = strtoull(source, &end, 10);
  int valid = errno == 0 && *end == 0;
  free(source);
  if (valid) *result = (uint64_t)parsed;
  return valid;
}

static napi_value open_anchor(napi_env env, napi_callback_info info) {
  size_t count = 3;
  napi_value args[3], result;
  uint64_t device, inode;
  owned_fds *owned = state(env);
  if (!owned || owned->anchor != -1) return fail(env, EINVAL);
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 3) return fail(env, EINVAL);
  char *path = text(env, args[0]);
  if (!path || path[0] != '/' || !decimal(env, args[1], &device) || !decimal(env, args[2], &inode)) {
    free(path);
    return fail(env, EINVAL);
  }
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  int error = errno;
  free(path);
  if (fd < 0) return fail(env, error);
  struct stat metadata;
  if (fstat(fd, &metadata) != 0) { error = errno; close(fd); return fail(env, error); }
  if ((uint64_t)metadata.st_dev != device || (uint64_t)metadata.st_ino != inode) {
    close(fd);
    return fail(env, ESTALE);
  }
  /* Probe the required kernel operation on this anchor; ENOSYS never falls back. */
  struct open_how how = {0};
  how.flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC;
  how.resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS;
  int probe = (int)syscall(SYS_openat2, fd, ".", &how, sizeof(how));
  if (probe < 0) { error = errno; close(fd); return fail(env, error); }
  close(probe);
  owned->anchor = fd;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value open_read(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value args[1], result;
  owned_fds *owned = state(env);
  if (!owned || owned->anchor < 0 || owned->reader >= 0) return fail(env, EINVAL);
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1) return fail(env, EINVAL);
  char *path = text(env, args[0]);
  if (!path || path[0] == '/') { free(path); return fail(env, EINVAL); }
  struct open_how how = {0};
  how.flags = O_RDONLY | O_NONBLOCK | O_CLOEXEC;
  how.resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS;
  int fd = (int)syscall(SYS_openat2, owned->anchor, path, &how, sizeof(how));
  int error = errno;
  free(path);
  if (fd < 0) return fail(env, error);
  struct stat metadata;
  if (fstat(fd, &metadata) != 0) { error = errno; close(fd); return fail(env, error); }
  if (!S_ISREG(metadata.st_mode) || metadata.st_nlink != 1) { close(fd); return fail(env, EPERM); }
  owned->reader = fd;
  napi_create_int32(env, fd, &result);
  return result;
}

static napi_value close_read(napi_env env, napi_callback_info info) {
  (void)info;
  owned_fds *owned = state(env);
  napi_value result;
  if (!owned || owned->reader < 0) return fail(env, EINVAL);
  int fd = owned->reader;
  owned->reader = -1;
  if (close(fd) != 0) return fail(env, errno);
  napi_get_undefined(env, &result);
  return result;
}

static napi_value open_metadata(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value args[1], result;
  owned_fds *owned = state(env);
  if (!owned || owned->anchor < 0 || owned->reader >= 0) return fail(env, EINVAL);
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1) return fail(env, EINVAL);
  char *path = text(env, args[0]);
  if (!path || path[0] == '/') { free(path); return fail(env, EINVAL); }
  struct open_how how = {0};
  how.flags = O_PATH | O_CLOEXEC;
  how.resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS;
  int fd = (int)syscall(SYS_openat2, owned->anchor, path, &how, sizeof(how));
  int error = errno;
  free(path);
  if (fd < 0) return fail(env, error);
  struct stat metadata;
  if (fstat(fd, &metadata) != 0) { error = errno; close(fd); return fail(env, error); }
  if ((!S_ISREG(metadata.st_mode) && !S_ISDIR(metadata.st_mode)) || (S_ISREG(metadata.st_mode) && metadata.st_nlink != 1)) {
    close(fd);
    return fail(env, EPERM);
  }
  owned->reader = fd;
  napi_create_int32(env, fd, &result);
  return result;
}

static napi_value close_anchor(napi_env env, napi_callback_info info) {
  (void)info;
  owned_fds *owned = state(env);
  napi_value result;
  if (!owned || owned->anchor < 0 || owned->reader >= 0) return fail(env, EINVAL);
  int fd = owned->anchor;
  owned->anchor = -1;
  if (close(fd) != 0) return fail(env, errno);
  napi_get_undefined(env, &result);
  return result;
}

static int fd_spelling(int fd, char *buffer, size_t limit) {
  char proc_path[64];
  int length = snprintf(proc_path, sizeof(proc_path), "/proc/self/fd/%d", fd);
  if (length < 0 || (size_t)length >= sizeof(proc_path)) return EIO;
  ssize_t count = readlink(proc_path, buffer, limit + 1);
  if (count < 0) return errno;
  if ((size_t)count > limit) return ENAMETOOLONG;
  buffer[count] = 0;
  return count > 0 && buffer[0] == '/' ? 0 : ESTALE;
}

static int same_identity(int left, int right) {
  struct stat a, b;
  if (fstat(left, &a) != 0 || fstat(right, &b) != 0) return errno;
  return a.st_dev == b.st_dev && a.st_ino == b.st_ino ? 0 : ESTALE;
}

static int verify_anchor_path(owned_fds *owned, const char *path) {
  int fd = open(path, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return errno;
  int error = same_identity(owned->anchor, fd);
  if (close(fd) != 0 && error == 0) error = errno;
  return error;
}

static napi_value canonical_path(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2], result;
  double extent;
  owned_fds *owned = state(env);
  if (!owned || owned->anchor < 0 || owned->reader < 0) return fail(env, EINVAL);
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 2
    || napi_get_value_double(env, args[1], &extent) != napi_ok
    || !(extent >= 1 && extent <= 16384) || extent != (uint32_t)extent) return fail(env, EINVAL);
  char *path = text(env, args[0]);
  if (!path || path[0] != '/') { free(path); return fail(env, EINVAL); }
  size_t limit = (size_t)extent;
  char *buffers = malloc(4 * (limit + 1));
  if (!buffers) { free(path); return fail(env, ENOMEM); }
  char *root = buffers, *target = root + limit + 1;
  char *root_after = target + limit + 1, *target_after = root_after + limit + 1;
  int error = fd_spelling(owned->anchor, root, limit);
  if (error == 0) error = fd_spelling(owned->reader, target, limit);
  const char *relative = NULL;
  if (error == 0) {
    size_t root_length = strlen(root);
    if (strcmp(root, target) == 0) relative = ".";
    else if (root_length == 1 && root[0] == '/') relative = target + 1;
    else if (strncmp(root, target, root_length) == 0 && target[root_length] == '/') relative = target + root_length + 1;
    else error = ESTALE;
  }
  if (error == 0) {
    /* The spelling only addresses a re-open: the same anchored kernel operation enforces authority. */
    struct open_how how = {0};
    how.flags = O_PATH | O_CLOEXEC;
    how.resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS;
    int fd = (int)syscall(SYS_openat2, owned->anchor, relative, &how, sizeof(how));
    if (fd < 0) error = errno;
    else {
      error = same_identity(owned->reader, fd);
      if (close(fd) != 0 && error == 0) error = errno;
    }
  }
  if (error == 0) error = fd_spelling(owned->anchor, root_after, limit);
  if (error == 0) error = fd_spelling(owned->reader, target_after, limit);
  if (error == 0 && (strcmp(root, root_after) != 0 || strcmp(target, target_after) != 0)) error = ESTALE;
  if (error == 0) error = verify_anchor_path(owned, path);
  /* Bounded root-NUL-target bytes preserve physical spelling without lossy UTF-8 conversion. */
  if (error == 0) {
    size_t root_length = strlen(root), target_length = strlen(target);
    size_t length = root_length + 1 + target_length;
    void *bytes = NULL;
    napi_value backing;
    if (napi_create_arraybuffer(env, length, &bytes, &backing) != napi_ok) error = EIO;
    else {
      unsigned char *output = bytes;
      memcpy(output, root, root_length);
      output[root_length] = 0;
      memcpy(output + root_length + 1, target, target_length);
      if (napi_create_typedarray(env, napi_uint8_array, length, backing, 0, &result) != napi_ok) error = EIO;
    }
  }
  free(buffers);
  free(path);
  return error == 0 ? result : fail(env, error);
}

static napi_value probe_kernel(napi_env env, napi_callback_info info) {
  (void)info;
  /* The probe holds no project or shared-storage capability and closes both descriptors. */
  int root = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (root < 0) return fail(env, errno);
  struct open_how how = {0};
  how.flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC;
  how.resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS;
  int probe = (int)syscall(SYS_openat2, root, ".", &how, sizeof(how));
  int error = errno;
  if (probe >= 0) close(probe);
  close(root);
  if (probe < 0) return fail(env, error);
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

/* ABI5 leaf operations own their complete FD lifetime and return a fixed, path-free fact frame. */
enum { LEAF_ATTEMPT = 1, LEAF_CREATED = 2, LEAF_ID = 4, LEAF_UNLINK = 8,
  LEAF_REMOVED = 16, LEAF_CLOSED = 32, LEAF_PARENT = 64 };

static void put32(unsigned char *out, uint32_t value) {
  for (unsigned i = 0; i < 4; i++) out[i] = (unsigned char)(value >> (8 * i));
}

static void put64(unsigned char *out, uint64_t value) {
  for (unsigned i = 0; i < 8; i++) out[i] = (unsigned char)(value >> (8 * i));
}

static int retire_close(int *owned) {
  if (*owned < 0) return 0;
  int fd = *owned;
  *owned = -1; /* Never retry a close on a number another thread could already have reused. */
  return close(fd) == 0 ? 0 : errno;
}

static char *bounded_text(napi_env env, napi_value value, size_t limit) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length == 0 || length > limit) return NULL;
  return text(env, value);
}

static int leaf_name(const char *leaf) {
  if (strcmp(leaf, "default-workspace") == 0) return 1;
  if (strlen(leaf) != 36 || leaf[14] != '4' || !strchr("89ab", leaf[19])) return 0;
  for (size_t i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (leaf[i] != '-') return 0; }
    else if (!((leaf[i] >= '0' && leaf[i] <= '9') || (leaf[i] >= 'a' && leaf[i] <= 'f'))) return 0;
  }
  return 1;
}

static int bounded_decimal(napi_env env, napi_value value, uint64_t *out) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length == 0 || length > 20) return 0;
  return decimal(env, value, out);
}

static int leaf_open(int parent, const char *leaf, uint64_t retries) {
  struct open_how how = {0};
  how.flags = O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC;
  how.resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS;
  uint64_t attempts = 0;
  for (;;) {
    int fd = (int)syscall(SYS_openat2, parent, leaf, &how, sizeof(how));
    if (fd >= 0 || errno != EAGAIN || attempts >= retries) return fd;
    attempts++;
  }
}

static int leaf_parent(owned_fds *owned, const char *path, int *close_failed) {
  int fd = open(path, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return errno;
  int error = same_identity(owned->anchor, fd);
  int closing = retire_close(&fd);
  if (closing != 0) { *close_failed = 1; return closing; }
  return error;
}

static int definite_no_create(int error) {
  /* Only the approved isolated local backend uses this syscall-result allowlist. */
  return error == EPERM || error == EACCES || error == EEXIST || error == ENOTDIR || error == EINVAL
    || error == ENOSPC || error == EROFS || error == ENAMETOOLONG || error == EDQUOT;
}

static napi_value leaf_operation(napi_env env, napi_callback_info info, int removing) {
  size_t count = removing ? 8 : 6;
  napi_value args[8], result;
  void *backing = NULL;
  owned_fds *owned = state(env);
  if (!owned || owned->anchor >= 0 || owned->reader >= 0) return fail(env, EINVAL);
  if (napi_create_arraybuffer(env, 64, &backing, &result) != napi_ok) return fail(env, ENOMEM);
  unsigned char *frame = backing;
  memset(frame, 0, 64);
  memcpy(frame, "DSF5", 4);
  frame[4] = 1; frame[5] = removing ? 2 : 1;
  napi_value array;
  if (napi_create_typedarray(env, napi_uint8_array, 64, result, 0, &array) != napi_ok) return fail(env, EIO);
  uint64_t parent_dev = 0, parent_ino = 0, expected_dev = 0, expected_ino = 0;
  double limit_value, retry_value;
  int error = EINVAL, mkdir_error = 0, phase = 0, tag = removing ? 7 : 3, close_failed = 0;
  uint32_t flags = 0;
  char *path = NULL, *leaf = NULL;
  size_t limit_index = removing ? 6 : 4;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != (removing ? 8u : 6u)
    || napi_get_value_double(env, args[limit_index], &limit_value) != napi_ok
    || napi_get_value_double(env, args[limit_index + 1], &retry_value) != napi_ok
    || !(limit_value >= 1 && limit_value <= 16384) || limit_value != (uint32_t)limit_value
    || !(retry_value >= 0 && retry_value <= 9007199254740991.0) || retry_value != (double)(uint64_t)retry_value) goto finished;
  path = bounded_text(env, args[0], (size_t)limit_value);
  leaf = bounded_text(env, args[3], 36);
  if (!path || path[0] != '/' || !leaf || !leaf_name(leaf)
    || strlen(path) + strlen(leaf) + (strcmp(path, "/") == 0 ? 0u : 1u) > (size_t)limit_value
    || !bounded_decimal(env, args[1], &parent_dev) || !bounded_decimal(env, args[2], &parent_ino)
    || (removing && (!bounded_decimal(env, args[4], &expected_dev) || !bounded_decimal(env, args[5], &expected_ino)))) goto finished;
  phase = 1;
  owned->anchor = open(path, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (owned->anchor < 0) { error = errno; goto finished; }
  struct stat parent, target;
  struct statfs backend;
  _Static_assert(4 * sizeof(struct stat) + sizeof(struct statfs) + sizeof(struct open_how) + 512 <= 2048,
    "leaf scratch exceeds reservation");
  _Static_assert(sizeof(parent.st_dev) <= 8 && sizeof(parent.st_ino) <= 8, "leaf identity exceeds fixed frame");
  if (fstat(owned->anchor, &parent) != 0) { error = errno; goto finished; }
  if ((uint64_t)parent.st_dev != parent_dev || (uint64_t)parent.st_ino != parent_ino) { error = ESTALE; goto finished; }
  flags |= LEAF_PARENT;
  put64(frame + 32, parent_dev); put64(frame + 40, parent_ino);
  if (fstatfs(owned->anchor, &backend) != 0) { error = errno; goto finished; }
  if (backend.f_type != TMPFS_MAGIC) { error = EOPNOTSUPP; goto finished; }
  phase = 2;
  owned->reader = leaf_open(owned->anchor, leaf, (uint64_t)retry_value);
  if (owned->reader < 0 && !removing && errno == ENOENT) {
    phase = 1;
    error = leaf_parent(owned, path, &close_failed);
    if (error != 0) goto finished;
    phase = 3;
    flags |= LEAF_ATTEMPT;
    if (mkdirat(owned->anchor, leaf, 0700) == 0) {
      flags |= LEAF_CREATED;
      tag = 5;
    } else {
      error = errno;
      mkdir_error = error;
      tag = definite_no_create(error) ? 3 : 5;
      if (error != EEXIST) goto finished;
    }
    phase = 4;
    owned->reader = leaf_open(owned->anchor, leaf, (uint64_t)retry_value);
  }
  if (owned->reader < 0) { error = errno; goto finished; }
  phase = 4;
  if (fstat(owned->reader, &target) != 0) { error = errno; goto finished; }
  if (!S_ISDIR(target.st_mode)) { error = ENOTDIR; goto finished; }
  if (removing || (flags & LEAF_CREATED)) {
    flags |= LEAF_ID;
    put64(frame + 16, (uint64_t)target.st_dev); put64(frame + 24, (uint64_t)target.st_ino);
    if (!removing) tag = 4;
  }
  if (removing && ((uint64_t)target.st_dev != expected_dev || (uint64_t)target.st_ino != expected_ino)) {
    error = ESTALE; goto finished;
  }
  phase = 5;
  error = leaf_parent(owned, path, &close_failed);
  if (error != 0) goto finished;
  if (removing) {
    phase = 6;
    flags |= LEAF_UNLINK;
    if (unlinkat(owned->anchor, leaf, AT_REMOVEDIR) != 0) { error = errno; goto finished; }
    flags |= LEAF_REMOVED;
    phase = 5;
    error = leaf_parent(owned, path, &close_failed);
    if (error != 0) goto finished;
    tag = 6;
  } else tag = (flags & LEAF_CREATED) ? 2 : 1;
  error = 0;
finished:
  {
    int closing = retire_close(&owned->reader);
    if (closing != 0) close_failed = 1;
    closing = retire_close(&owned->anchor);
    if (closing != 0) close_failed = 1;
  }
  free(path); free(leaf);
  if (close_failed) return fail(env, EIO);
  flags |= LEAF_CLOSED;
  frame[6] = (unsigned char)tag; frame[7] = (unsigned char)phase;
  put32(frame + 8, (uint32_t)error); put32(frame + 12, flags);
  put32(frame + 48, (uint32_t)mkdir_error);
  return array;
}

static napi_value prepare_leaf(napi_env env, napi_callback_info info) { return leaf_operation(env, info, 0); }
static napi_value remove_empty_leaf(napi_env env, napi_callback_info info) { return leaf_operation(env, info, 1); }

static void cleanup(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  owned_fds *owned = data;
  if (owned->reader >= 0) close(owned->reader);
  if (owned->anchor >= 0) close(owned->anchor);
  free(owned);
}

static napi_value init(napi_env env, napi_value exports) {
  owned_fds *owned = malloc(sizeof(*owned));
  if (!owned) return fail(env, ENOMEM);
  owned->anchor = -1;
  owned->reader = -1;
  if (napi_set_instance_data(env, owned, cleanup, NULL) != napi_ok) { free(owned); return fail(env, EIO); }
  napi_property_descriptor methods[] = {
    {"openAnchor", NULL, open_anchor, NULL, NULL, NULL, napi_default, NULL},
    {"openRead", NULL, open_read, NULL, NULL, NULL, napi_default, NULL},
    {"closeRead", NULL, close_read, NULL, NULL, NULL, napi_default, NULL},
    {"openMetadata", NULL, open_metadata, NULL, NULL, NULL, napi_default, NULL},
    {"closeAnchor", NULL, close_anchor, NULL, NULL, NULL, napi_default, NULL},
    {"canonicalPath", NULL, canonical_path, NULL, NULL, NULL, napi_default, NULL},
    {"probeKernel", NULL, probe_kernel, NULL, NULL, NULL, napi_default, NULL},
    {"prepareLeaf", NULL, prepare_leaf, NULL, NULL, NULL, napi_default, NULL},
    {"removeEmptyLeaf", NULL, remove_empty_leaf, NULL, NULL, NULL, napi_default, NULL}
  };
  napi_value abi;
  napi_create_uint32(env, 5, &abi);
  napi_set_named_property(env, exports, "abiVersion", abi);
  napi_define_properties(env, exports, 9, methods);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
