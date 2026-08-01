/* ovolv999-sandbox-helper — Linux sandbox wrapper using Landlock.
 *
 * Usage: ovolv999-sandbox-helper <workdir> <command> [args...]
 *
 * Steps:
 *   1. set PR_SET_NO_NEW_PRIVS (forbid setuid escalation inside the sandbox)
 *   2. apply Landlock rules: read-only workdir + /usr + /lib + /etc + /tmp,
 *      read-write workdir + /tmp
 *   3. deny network via Landlock ABI (kernel 6.7+) — best-effort
 *   4. execve the requested command
 *
 * Falls back to execve-without-restrictions on older kernels (< 5.13)
 * that don't have Landlock; the user is warned via stderr.
 *
 * Build: cc -O2 scripts/sandbox-helper.c -o ~/.ovolv999/bin/ovolv999-sandbox-helper
 *
 * This is intentionally small (~150 lines) to keep the install surface
 * minimal — no libcap, no seccomp helpers, just kernel syscalls.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef PR_SET_NO_NEW_PRIVS
#define PR_SET_NO_NEW_PRIVS 38
#endif

static int sys_landlock_create_ruleset(const struct landlock_ruleset_attr *attr, size_t size, uint32_t flags) {
  return syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static int sys_landlock_add_rule(int fd, enum landlock_key_type type, const void *const attr, uint32_t flags) {
  return syscall(__NR_landlock_add_rule, fd, type, attr, flags);
}

static int sys_landlock_restrict_self(int fd, uint32_t flags) {
  return syscall(__NR_landlock_restrict_self, fd, flags);
}

static int path_rule(int fd, const char *path, uint64_t access, int is_dir) {
  struct landlock_path_beneath_attr pb = {0};
  pb.allowed_access = access;
  pb.parent_fd = open(path, O_PATH | O_CLOEXEC);
  if (pb.parent_fd < 0) {
    fprintf(stderr, "[sandbox-helper] skip %s (%s)\n", path, strerror(errno));
    return 0;
  }
  int r = sys_landlock_add_rule(fd, LANDLOCK_KEY_TYPE_PATH_BENEATH, &pb, 0);
  close(pb.parent_fd);
  if (r < 0) {
    fprintf(stderr, "[sandbox-helper] add rule %s failed: %s\n", path, strerror(errno));
    return -1;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "Usage: %s <workdir> <command> [args...]\n", argv[0]);
    return 2;
  }
  const char *workdir = argv[1];
  const char *command = argv[2];
  char **command_argv = &argv[2];

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
    fprintf(stderr, "[sandbox-helper] prctl(PR_SET_NO_NEW_PRIVS) failed: %s\n", strerror(errno));
    return 1;
  }

  struct landlock_ruleset_attr ruleset = {0};
  ruleset.handled_access_fs = LANDLOCK_ACCESS_FS_EXECUTE
                           | LANDLOCK_ACCESS_FS_READ_FILE
                           | LANDLOCK_ACCESS_FS_WRITE_FILE
                           | LANDLOCK_ACCESS_FS_READ_DIR
                           | LANDLOCK_ACCESS_FS_REMOVE_DIR
                           | LANDLOCK_ACCESS_FS_REMOVE_FILE
                           | LANDLOCK_ACCESS_FS_MAKE_CHAR
                           | LANDLOCK_ACCESS_FS_MAKE_DIR
                           | LANDLOCK_ACCESS_FS_MAKE_REG
                           | LANDLOCK_ACCESS_FS_MAKE_SOCK
                           | LANDLOCK_ACCESS_FS_MAKE_FIFO
                           | LANDLOCK_ACCESS_FS_MAKE_BLOCK
                           | LANDLOCK_ACCESS_FS_MAKE_SYM;
  ruleset.handled_access_net = LANDLOCK_ACCESS_NET_BIND_TCP
                            | LANDLOCK_ACCESS_NET_CONNECT_TCP;

  int abi = sys_landlock_create_ruleset(&ruleset, sizeof(ruleset), 0);
  if (abi < 0) {
    if (errno == ENOSYS || errno == EOPNOTSUPP) {
      fprintf(stderr, "[sandbox-helper] Landlock unsupported on this kernel; running unrestricted\n");
      execvp(command, command_argv);
      fprintf(stderr, "[sandbox-helper] execvp failed: %s\n", strerror(errno));
      return 1;
    }
    fprintf(stderr, "[sandbox-helper] landlock_create_ruleset failed: %s\n", strerror(errno));
    return 1;
  }

  /* Read-only paths */
  uint64_t ro = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_EXECUTE;
  path_rule(abi, "/usr", ro, 1);
  path_rule(abi, "/lib", ro, 1);
  path_rule(abi, "/lib64", ro, 1);
  path_rule(abi, "/etc", ro, 1);
  path_rule(abi, "/bin", ro, 1);
  path_rule(abi, "/sbin", ro, 1);
  path_rule(abi, "/dev", ro, 1);
  path_rule(abi, "/proc", ro, 1);
  path_rule(abi, "/sys", ro, 1);

  /* Workdir + /tmp: read-write + execute */
  uint64_t rw = ro
              | LANDLOCK_ACCESS_FS_WRITE_FILE
              | LANDLOCK_ACCESS_FS_REMOVE_DIR
              | LANDLOCK_ACCESS_FS_REMOVE_FILE
              | LANDLOCK_ACCESS_FS_MAKE_CHAR
              | LANDLOCK_ACCESS_FS_MAKE_DIR
              | LANDLOCK_ACCESS_FS_MAKE_REG
              | LANDLOCK_ACCESS_FS_MAKE_SOCK
              | LANDLOCK_ACCESS_FS_MAKE_FIFO
              | LANDLOCK_ACCESS_FS_MAKE_BLOCK
              | LANDLOCK_ACCESS_FS_MAKE_SYM;
  path_rule(abi, workdir, rw, 1);
  path_rule(abi, "/tmp", rw, 1);
  path_rule(abi, "/var/tmp", rw, 1);

  if (sys_landlock_restrict_self(abi, 0) < 0) {
    fprintf(stderr, "[sandbox-helper] landlock_restrict_self failed: %s\n", strerror(errno));
    return 1;
  }

  /* Best-effort: chdir to workdir (relative paths in command will resolve there) */
  if (chdir(workdir) < 0) {
    fprintf(stderr, "[sandbox-helper] chdir %s failed: %s\n", workdir, strerror(errno));
    return 1;
  }

  execvp(command, command_argv);
  fprintf(stderr, "[sandbox-helper] execvp %s failed: %s\n", command, strerror(errno));
  return 1;
}
