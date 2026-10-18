/* Read-only Linux storage probe ABI1. It does not mount, allocate, resize, or issue account authority. */
#define _GNU_SOURCE
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/openat2.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <unistd.h>

static napi_value failure(napi_env env, int error, int close_failed) {
  (void)error;
  napi_throw_error(env, close_failed ? "DSH_STORAGE_CLOSE" : "DSH_STORAGE_PROBE", "Storage probe failed");
  return NULL;
}

static int retire(int *fd) {
  if (*fd < 0) return 0;
  int old = *fd;
  *fd = -1;
  return close(old) == 0 ? 0 : errno;
}

static char *bounded_text(napi_env env, napi_value value, size_t limit) {
  size_t length = 0, actual = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || !length || length > limit) return NULL;
  char *result = malloc(length + 1);
  if (!result) return NULL;
  if (napi_get_value_string_utf8(env, value, result, length + 1, &actual) != napi_ok || actual != length || strlen(result) != length) {
    free(result); return NULL;
  }
  return result;
}

/* Every ancestor is held until its child opens; no symlinks or writable/non-root parent is trusted. */
static int checked_path(const char *path, int *protected, int *close_failed) {
  int fd = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) return -1;
  const char *cursor = path + 1;
  *protected = 1;
  while (*cursor) {
    struct stat parent;
    if (fstat(fd, &parent) != 0) goto failed;
    if (parent.st_uid != 0 || (parent.st_mode & 0022)) *protected = 0;
    const char *end = strchr(cursor, '/');
    size_t size = end ? (size_t)(end - cursor) : strlen(cursor);
    if (size == 0 || size > NAME_MAX || (size == 1 && cursor[0] == '.')
      || (size == 2 && cursor[0] == '.' && cursor[1] == '.')) { errno = EINVAL; goto failed; }
    char component[NAME_MAX + 1];
    memcpy(component, cursor, size); component[size] = 0;
    struct open_how how = {0};
    how.flags = O_PATH | O_NOFOLLOW | O_CLOEXEC | (end ? O_DIRECTORY : 0);
    how.resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS;
    int next = (int)syscall(SYS_openat2, fd, component, &how, sizeof(how));
    if (next < 0) goto failed;
    if (retire(&fd) != 0) {
      *close_failed = 1;
      if (retire(&next) != 0) *close_failed = 1;
      errno = EIO; return -1;
    }
    fd = next;
    if (!end) return fd;
    cursor = end + 1;
  }
  return fd;
failed:
  {
    int error = errno;
    if (retire(&fd) != 0) *close_failed = 1;
    errno = error; return -1;
  }
}

static void put32(unsigned char *p, uint32_t n) { for (int i = 0; i < 4; i++) p[i] = (unsigned char)(n >> (8 * i)); }
static void put64(unsigned char *p, uint64_t n) { for (int i = 0; i < 8; i++) p[i] = (unsigned char)(n >> (8 * i)); }

static napi_value probe(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2], result, array;
  double maximum;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 2
    || napi_get_value_double(env, args[1], &maximum) != napi_ok || maximum < 1 || maximum > 16384
    || maximum != (uint32_t)maximum) return failure(env, EINVAL, 0);
  char *path = bounded_text(env, args[0], (size_t)maximum);
  if (!path || path[0] != '/') { free(path); return failure(env, EINVAL, 0); }
  int protected = 0, close_failed = 0, error = 0;
  int fd = checked_path(path, &protected, &close_failed);
  free(path);
  if (fd < 0) return failure(env, errno, close_failed);
  struct stat metadata;
  struct statfs filesystem;
  struct statx identity;
  unsigned char frame[256] = {0};
  if (fstat(fd, &metadata) != 0 || fstatfs(fd, &filesystem) != 0
    || statx(fd, "", AT_EMPTY_PATH | AT_STATX_SYNC_AS_STAT, STATX_MNT_ID, &identity) != 0) { error = errno; goto finished; }
  if (!(identity.stx_mask & STATX_MNT_ID) || !identity.stx_mnt_id
    || (!S_ISDIR(metadata.st_mode) && !S_ISREG(metadata.st_mode)) || metadata.st_size < 0 || metadata.st_blocks < 0
    || (uint64_t)metadata.st_blocks > UINT64_MAX / 512) {
    error = EOPNOTSUPP; goto finished;
  }
  frame[6] = protected ? 2 : 0;
  for (int i = 0; i < 3; i++) {
    int access = i == 0 ? W_OK : i == 1 ? R_OK : X_OK;
    if (syscall(SYS_faccessat2, fd, "", access, AT_EMPTY_PATH | AT_EACCESS) == 0) frame[6] |= (unsigned char)(4 << i);
    else if (errno != EACCES && errno != EROFS && errno != EPERM) { error = errno; goto finished; }
  }
  if (filesystem.f_flags & ST_RDONLY) frame[6] |= 32;
  memcpy(frame, "DSP1", 4); frame[4] = 1; frame[5] = 1;
  put32(frame + 12, metadata.st_uid); put32(frame + 16, metadata.st_gid); put32(frame + 20, metadata.st_mode);
  put32(frame + 24, geteuid()); put32(frame + 28, getegid());
  put64(frame + 32, metadata.st_dev); put64(frame + 40, metadata.st_ino); put64(frame + 48, identity.stx_mnt_id);
  put64(frame + 56, (uint64_t)(unsigned long)filesystem.f_type); put64(frame + 64, filesystem.f_bsize);
  put64(frame + 72, filesystem.f_blocks); put64(frame + 80, filesystem.f_bfree); put64(frame + 88, filesystem.f_bavail);
  put64(frame + 96, filesystem.f_files); put64(frame + 104, filesystem.f_ffree); put64(frame + 112, metadata.st_size);
  put64(frame + 120, (uint64_t)metadata.st_blocks * 512); put64(frame + 128, metadata.st_nlink);
finished:
  if (retire(&fd) != 0) close_failed = 1;
  if (error || close_failed) return failure(env, error, close_failed);
  frame[6] |= 1;
  void *data = NULL;
  if (napi_create_arraybuffer(env, 256, &data, &result) != napi_ok) return failure(env, ENOMEM, 0);
  memcpy(data, frame, 256);
  if (napi_create_typedarray(env, napi_uint8_array, 256, result, 0, &array) != napi_ok) return failure(env, EIO, 0);
  return array;
}

static napi_value read_record(napi_env env, napi_callback_info info) {
  size_t count = 3;
  napi_value args[3], result, array;
  double maximum, path_maximum;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 3
    || napi_get_value_double(env, args[1], &maximum) != napi_ok || maximum < 1 || maximum > 262144 || maximum != (uint32_t)maximum
    || napi_get_value_double(env, args[2], &path_maximum) != napi_ok || path_maximum < 1 || path_maximum > 16384
    || path_maximum != (uint32_t)path_maximum) return failure(env, EINVAL, 0);
  char *path = bounded_text(env, args[0], (size_t)path_maximum);
  if (!path || path[0] != '/') { free(path); return failure(env, EINVAL, 0); }
  int protected = 0, close_failed = 0, error = 0, reader = -1;
  int anchor = checked_path(path, &protected, &close_failed);
  free(path);
  unsigned char *bytes = NULL;
  size_t length = 0;
  if (anchor < 0) return failure(env, errno, close_failed);
  struct stat before, after;
  if (fstat(anchor, &before) != 0) { error = errno; goto finished; }
  if (!protected || !S_ISREG(before.st_mode) || before.st_uid != 0 || (before.st_mode & 0022) || before.st_nlink != 1
    || before.st_size <= 0 || (uint64_t)before.st_size > (uint64_t)maximum) { error = EACCES; goto finished; }
  char descriptor[64];
  if (snprintf(descriptor, sizeof(descriptor), "/proc/self/fd/%d", anchor) >= (int)sizeof(descriptor)) { error = EIO; goto finished; }
  reader = open(descriptor, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
  if (reader < 0) { error = errno; goto finished; }
  if (fstat(reader, &after) != 0) { error = errno; goto finished; }
  if (before.st_dev != after.st_dev || before.st_ino != after.st_ino) { error = ESTALE; goto finished; }
  bytes = malloc((size_t)maximum + 1);
  if (!bytes) { error = ENOMEM; goto finished; }
  for (;;) {
    ssize_t got = read(reader, bytes + length, (size_t)maximum + 1 - length);
    if (got < 0) { error = errno; goto finished; }
    if (!got) break;
    length += (size_t)got;
    if (length > (size_t)maximum) { error = EFBIG; goto finished; }
  }
  if (fstat(reader, &after) != 0) { error = errno; goto finished; }
  if ((uint64_t)after.st_size != length || after.st_size != before.st_size
    || after.st_mtim.tv_sec != before.st_mtim.tv_sec || after.st_mtim.tv_nsec != before.st_mtim.tv_nsec
    || after.st_ctim.tv_sec != before.st_ctim.tv_sec || after.st_ctim.tv_nsec != before.st_ctim.tv_nsec) error = ESTALE;
finished:
  if (retire(&reader) != 0) close_failed = 1;
  if (retire(&anchor) != 0) close_failed = 1;
  if (error || close_failed) { free(bytes); return failure(env, error, close_failed); }
  void *data = NULL;
  if (napi_create_arraybuffer(env, length, &data, &result) != napi_ok) { free(bytes); return failure(env, ENOMEM, 0); }
  memcpy(data, bytes, length); free(bytes);
  if (napi_create_typedarray(env, napi_uint8_array, length, result, 0, &array) != napi_ok) return failure(env, EIO, 0);
  return array;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"probe", NULL, probe, NULL, NULL, NULL, napi_default, NULL},
    {"readRecord", NULL, read_record, NULL, NULL, NULL, napi_default, NULL}
  };
  napi_value version;
  napi_create_uint32(env, 1, &version);
  napi_set_named_property(env, exports, "abiVersion", version);
  napi_define_properties(env, exports, 2, methods);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
