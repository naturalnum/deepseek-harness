/* Test-only creation faults around the original native helper; never part of a product build. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static int creation_fault(const char *name, uint64_t flags) {
  return (flags & O_CREAT) && (!strncmp(name, ".stage-", 7) || !strncmp(name, ".dsh-text-", 10));
}

static int denied(void) {
  const char *mode = getenv("DSH_FILES_CREATE_FAILURE");
  return mode && !strcmp(mode, "denied");
}

static long after_creation(long fd) {
  const char *mode = getenv("DSH_FILES_CREATE_FAILURE");
  if (fd >= 0 && mode && !strcmp(mode, "after-effect")) {
    if (close((int)fd)) return -1;
    errno = EIO;
    return -1;
  }
  return fd;
}

#ifdef DSH_REVIEW_SKILL
#include <linux/magic.h>
#include <sys/vfs.h>

/* Qualification is explicitly emulated; this fixture makes no ext4/isolation claim. */
static int review_fstatfs(int fd, struct statfs *facts) {
  int result = fstatfs(fd, facts);
  if (!result) facts->f_type = EXT4_SUPER_MAGIC;
  return result;
}

static int review_mkdirat(int directory, const char *name, mode_t permissions) {
  const char *target = getenv("DSH_FILES_CREATE_TARGET");
  int inject = target && (!strcmp(target, "container") ? !strcmp(name, "skills") : !strncmp(name, ".pending-", 9));
  if (inject && denied()) { errno = EACCES; return -1; }
  int result = mkdirat(directory, name, permissions);
  const char *mode = getenv("DSH_FILES_CREATE_FAILURE");
  if (!result && inject && mode && !strcmp(mode, "after-effect")) { errno = EIO; return -1; }
  return result;
}
#define fstatfs review_fstatfs
#define mkdirat review_mkdirat
#include "../../native/fd.c"
#elif defined(DSH_REVIEW_TEXT)
static int review_openat(int directory, const char *name, int flags, ...) {
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list args;
    va_start(args, flags);
    mode = va_arg(args, mode_t);
    va_end(args);
  }
  int inject = creation_fault(name, (uint64_t)flags);
  if (inject && denied()) { errno = EACCES; return -1; }
  long fd = syscall(SYS_openat, directory, name, flags, mode);
  return (int)(inject ? after_creation(fd) : fd);
}
#define openat review_openat
#include "../../native/fd.c"
#else
static long review_syscall(long number, ...) {
  va_list args;
  va_start(args, number);
  if (number == SYS_openat2) {
    int directory = va_arg(args, int);
    const char *name = va_arg(args, const char *);
    const struct open_how *how = va_arg(args, const struct open_how *);
    size_t size = va_arg(args, size_t);
    va_end(args);
    int inject = creation_fault(name, how->flags);
    if (inject && denied()) { errno = EACCES; return -1; }
    long fd = syscall(number, directory, name, how, size);
    return inject ? after_creation(fd) : fd;
  }
  if (number == SYS_renameat2) {
    int source = va_arg(args, int);
    const char *old = va_arg(args, const char *);
    int destination = va_arg(args, int);
    const char *name = va_arg(args, const char *);
    unsigned flags = va_arg(args, unsigned);
    va_end(args);
    return syscall(number, source, old, destination, name, flags);
  }
  va_end(args);
  errno = ENOSYS;
  return -1;
}
#define syscall review_syscall
#include "../../native/staging.c"
#endif
