#include <dirent.h>
#include <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <unistd.h>

static void fail(const char *label) {
  fprintf(stderr, "%s: %s\n", label, strerror(errno));
  exit(1);
}

static void invalid(const char *label) {
  fprintf(stderr, "%s\n", label);
  exit(1);
}

static int valid_component(const char *value) {
  return value[0] != '\0' && strcmp(value, ".") != 0 && strcmp(value, "..") != 0;
}

static void validate_relative(const char *path) {
  if (path == NULL || path[0] == '\0' || path[0] == '/' || path[strlen(path) - 1] == '/' || strstr(path, "//") != NULL) {
    invalid("path must be confined and relative");
  }
  char *copy = strdup(path);
  if (copy == NULL) fail("strdup");
  char *save = NULL;
  for (char *part = strtok_r(copy, "/", &save); part != NULL; part = strtok_r(NULL, "/", &save)) {
    if (!valid_component(part)) invalid("path contains an unsafe component");
  }
  free(copy);
}

static int open_root(const char *root) {
  int fd = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) fail("open project root");
  return fd;
}

static int open_directory_path(int root, const char *path) {
  if (path[0] == '\0') {
    int fd = dup(root);
    if (fd < 0) fail("dup project root");
    return fd;
  }
  char *copy = strdup(path);
  if (copy == NULL) fail("strdup");
  int current = dup(root);
  if (current < 0) fail("dup project root");
  char *save = NULL;
  for (char *part = strtok_r(copy, "/", &save); part != NULL; part = strtok_r(NULL, "/", &save)) {
    int next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) fail("openat directory without symlink following");
    close(current);
    current = next;
  }
  free(copy);
  return current;
}

static int open_parent(int root, const char *path, char **leaf) {
  validate_relative(path);
  char *copy = strdup(path);
  if (copy == NULL) fail("strdup");
  char *slash = strrchr(copy, '/');
  if (slash == NULL) {
    *leaf = strdup(copy);
    free(copy);
    if (*leaf == NULL) fail("strdup");
    return open_directory_path(root, "");
  }
  *slash = '\0';
  *leaf = strdup(slash + 1);
  if (*leaf == NULL) fail("strdup");
  int parent = open_directory_path(root, copy);
  free(copy);
  return parent;
}

static void print_owner_fd(int fd) {
  struct stat info;
  if (fstat(fd, &info) != 0) fail("fstat");
  printf("%llu %llu\n", (unsigned long long)info.st_dev, (unsigned long long)info.st_ino);
}

static void write_all(int fd, const unsigned char *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(fd, bytes + offset, length - offset);
    if (written < 0) fail("write");
    offset += (size_t)written;
  }
}

static void copy_stream(int source, int target) {
  unsigned char buffer[65536];
  for (;;) {
    ssize_t count = read(source, buffer, sizeof(buffer));
    if (count < 0) fail("read source");
    if (count == 0) return;
    write_all(target, buffer, (size_t)count);
  }
}

static void write_stdin(int target) {
  unsigned char buffer[65536];
  for (;;) {
    ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
    if (count < 0) fail("read stdin");
    if (count == 0) return;
    write_all(target, buffer, (size_t)count);
  }
}

static unsigned long long parse_owner(const char *value) {
  char *end = NULL;
  errno = 0;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0') invalid("invalid owner identity");
  return parsed;
}

static int same_owner(const struct stat *info, const char *dev, const char *ino) {
  return (unsigned long long)info->st_dev == parse_owner(dev) && (unsigned long long)info->st_ino == parse_owner(ino);
}

static void command_write(int root, const char *path) {
  char *leaf = NULL;
  int parent = open_parent(root, path, &leaf);
  int target = openat(parent, leaf, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (target < 0) fail("create exclusive file");
  write_stdin(target);
  if (fsync(target) != 0) fail("fsync file");
  if (fsync(parent) != 0) fail("fsync parent directory");
  print_owner_fd(target);
  close(target);
  close(parent);
  free(leaf);
}

static void command_copy(int root, const char *source_path, const char *target_path) {
  char *source_leaf = NULL;
  char *target_leaf = NULL;
  int source_parent = open_parent(root, source_path, &source_leaf);
  int target_parent = open_parent(root, target_path, &target_leaf);
  int source = openat(source_parent, source_leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (source < 0) fail("open source file");
  struct stat source_info;
  if (fstat(source, &source_info) != 0 || !S_ISREG(source_info.st_mode)) invalid("source must be a regular file");
  int target = openat(target_parent, target_leaf, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (target < 0) fail("create exclusive copy");
  copy_stream(source, target);
  if (fsync(target) != 0) fail("fsync copied file");
  if (fsync(target_parent) != 0) fail("fsync copy directory");
  print_owner_fd(target);
  close(target);
  close(source);
  close(target_parent);
  close(source_parent);
  free(target_leaf);
  free(source_leaf);
}

static void command_mkdir_exclusive(int root, const char *path) {
  char *leaf = NULL;
  int parent = open_parent(root, path, &leaf);
  if (mkdirat(parent, leaf, 0700) != 0) fail("create exclusive directory");
  int directory = openat(parent, leaf, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory < 0) fail("open created directory");
  if (fsync(directory) != 0 || fsync(parent) != 0) fail("fsync created directory");
  print_owner_fd(directory);
  close(directory);
  close(parent);
  free(leaf);
}

static void command_mkdirs(int root, const char *path) {
  validate_relative(path);
  char *copy = strdup(path);
  if (copy == NULL) fail("strdup");
  int current = dup(root);
  if (current < 0) fail("dup project root");
  char *save = NULL;
  for (char *part = strtok_r(copy, "/", &save); part != NULL; part = strtok_r(NULL, "/", &save)) {
    if (mkdirat(current, part, 0700) != 0 && errno != EEXIST) fail("mkdirat");
    int next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) fail("openat created directory without symlink following");
    if (fsync(current) != 0) fail("fsync mkdir parent");
    close(current);
    current = next;
  }
  if (fsync(current) != 0) fail("fsync final directory");
  print_owner_fd(current);
  close(current);
  free(copy);
}

static void command_rename_exclusive(int root, const char *source_path, const char *target_path, const char *dev, const char *ino) {
  char *source_leaf = NULL;
  char *target_leaf = NULL;
  int source_parent = open_parent(root, source_path, &source_leaf);
  int target_parent = open_parent(root, target_path, &target_leaf);
  int source = openat(source_parent, source_leaf, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (source < 0) fail("open staging directory for rename");
  struct stat source_info;
  if (fstat(source, &source_info) != 0 || !same_owner(&source_info, dev, ino)) invalid("staging directory owner changed before rename");
  close(source);
  if (renameatx_np(source_parent, source_leaf, target_parent, target_leaf, RENAME_EXCL) != 0) fail("rename exclusive");
  if (fsync(target_parent) != 0 || fsync(source_parent) != 0) fail("fsync rename directories");
  close(target_parent);
  close(source_parent);
  free(target_leaf);
  free(source_leaf);
}

static void command_read(int root, const char *path) {
  char *leaf = NULL;
  int parent = open_parent(root, path, &leaf);
  int source = openat(parent, leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (source < 0) fail("open file without symlink following");
  struct stat info;
  if (fstat(source, &info) != 0 || !S_ISREG(info.st_mode)) invalid("path must be a regular file");
  fprintf(stderr, "%llu %llu\n", (unsigned long long)info.st_dev, (unsigned long long)info.st_ino);
  copy_stream(source, STDOUT_FILENO);
  close(source);
  close(parent);
  free(leaf);
}

static void command_hash(int root, const char *path) {
  char *leaf = NULL;
  int parent = open_parent(root, path, &leaf);
  int source = openat(parent, leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (source < 0) fail("open file for hash without symlink following");
  struct stat info;
  if (fstat(source, &info) != 0 || !S_ISREG(info.st_mode)) invalid("hash path must be a regular file");
  CC_SHA256_CTX context;
  if (CC_SHA256_Init(&context) != 1) invalid("initialize SHA-256 failed");
  unsigned char buffer[65536];
  for (;;) {
    ssize_t count = read(source, buffer, sizeof(buffer));
    if (count < 0) fail("read hash source");
    if (count == 0) break;
    if (CC_SHA256_Update(&context, buffer, (CC_LONG)count) != 1) invalid("update SHA-256 failed");
  }
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  if (CC_SHA256_Final(digest, &context) != 1) invalid("finish SHA-256 failed");
  for (size_t index = 0; index < sizeof(digest); index += 1) printf("%02x", digest[index]);
  printf(" %llu %llu %llu %lld %ld\n", (unsigned long long)info.st_dev, (unsigned long long)info.st_ino, (unsigned long long)info.st_size, (long long)info.st_mtimespec.tv_sec, info.st_mtimespec.tv_nsec);
  close(source);
  close(parent);
  free(leaf);
}

static void command_lock(int root, const char *path) {
  char *leaf = NULL;
  int parent = open_parent(root, path, &leaf);
  int lock = openat(parent, leaf, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (lock < 0) fail("open project lock without symlink following");
  struct stat info;
  if (fstat(lock, &info) != 0 || !S_ISREG(info.st_mode)) invalid("project lock must be a regular file");
  if (flock(lock, LOCK_EX) != 0) fail("acquire project lock");
  if (printf("READY\n") < 0 || fflush(stdout) != 0) fail("report project lock readiness");
  unsigned char buffer[64];
  for (;;) {
    ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
    if (count == 0) break;
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) fail("wait for project lock release");
  }
  if (flock(lock, LOCK_UN) != 0) fail("release project lock");
  close(lock);
  close(parent);
  free(leaf);
}

static void command_remove_file(int root, const char *path, const char *dev, const char *ino) {
  char *leaf = NULL;
  int parent = open_parent(root, path, &leaf);
  struct stat info;
  if (fstatat(parent, leaf, &info, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) {
      printf("0\n");
      return;
    }
    fail("stat owned file");
  }
  if (!S_ISREG(info.st_mode) || !same_owner(&info, dev, ino)) {
    printf("0\n");
    return;
  }
  if (unlinkat(parent, leaf, 0) != 0) fail("unlink owned file");
  if (fsync(parent) != 0) fail("fsync unlink directory");
  printf("1\n");
  close(parent);
  free(leaf);
}

static void command_remove_stage(int root, const char *path, const char *dev, const char *ino) {
  char *leaf = NULL;
  int parent = open_parent(root, path, &leaf);
  int stage = openat(parent, leaf, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (stage < 0) {
    if (errno == ENOENT) {
      printf("0\n");
      return;
    }
    fail("open owned staging directory");
  }
  struct stat info;
  if (fstat(stage, &info) != 0) fail("fstat staging directory");
  if (!same_owner(&info, dev, ino)) {
    printf("0\n");
    return;
  }
  DIR *entries = fdopendir(dup(stage));
  if (entries == NULL) fail("fdopendir staging directory");
  struct dirent *entry;
  while ((entry = readdir(entries)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    struct stat child;
    if (fstatat(stage, entry->d_name, &child, AT_SYMLINK_NOFOLLOW) != 0) fail("stat staging child");
    if (!S_ISREG(child.st_mode) && !S_ISLNK(child.st_mode)) invalid("staging cleanup found unexpected directory");
    if (unlinkat(stage, entry->d_name, 0) != 0) fail("unlink staging child");
  }
  closedir(entries);
  struct stat current;
  if (fstatat(parent, leaf, &current, AT_SYMLINK_NOFOLLOW) != 0 || !same_owner(&current, dev, ino)) {
    printf("0\n");
    return;
  }
  close(stage);
  if (unlinkat(parent, leaf, AT_REMOVEDIR) != 0) fail("remove owned staging directory");
  if (fsync(parent) != 0) fail("fsync staging parent");
  printf("1\n");
  close(parent);
  free(leaf);
}

int main(int argc, char **argv) {
  if (argc < 4) invalid("usage: release-fs operation root relative-path [...]");
  int root = open_root(argv[2]);
  if (strcmp(argv[1], "write-exclusive") == 0 && argc == 4) command_write(root, argv[3]);
  else if (strcmp(argv[1], "copy-exclusive") == 0 && argc == 5) command_copy(root, argv[3], argv[4]);
  else if (strcmp(argv[1], "mkdir-exclusive") == 0 && argc == 4) command_mkdir_exclusive(root, argv[3]);
  else if (strcmp(argv[1], "mkdirs") == 0 && argc == 4) command_mkdirs(root, argv[3]);
  else if (strcmp(argv[1], "rename-exclusive") == 0 && argc == 7) command_rename_exclusive(root, argv[3], argv[4], argv[5], argv[6]);
  else if (strcmp(argv[1], "read") == 0 && argc == 4) command_read(root, argv[3]);
  else if (strcmp(argv[1], "hash") == 0 && argc == 4) command_hash(root, argv[3]);
  else if (strcmp(argv[1], "lock") == 0 && argc == 4) command_lock(root, argv[3]);
  else if (strcmp(argv[1], "remove-file-owned") == 0 && argc == 6) command_remove_file(root, argv[3], argv[4], argv[5]);
  else if (strcmp(argv[1], "remove-stage-owned") == 0 && argc == 6) command_remove_stage(root, argv[3], argv[4], argv[5]);
  else invalid("unknown release-fs operation");
  close(root);
  return 0;
}
