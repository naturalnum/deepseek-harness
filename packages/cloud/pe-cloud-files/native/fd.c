/* Linux-only N-API helper. Each worker owns one anchor and one open regular file. */
#define _GNU_SOURCE
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
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
    {"probeKernel", NULL, probe_kernel, NULL, NULL, NULL, napi_default, NULL}
  };
  napi_value abi;
  napi_create_uint32(env, 3, &abi);
  napi_set_named_property(env, exports, "abiVersion", abi);
  napi_define_properties(env, exports, 6, methods);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
