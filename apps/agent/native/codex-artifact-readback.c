#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define ARTIFACT_MAX_FILE_BYTES (512u * 1024u * 1024u)
#define ARTIFACT_MAX_LINK_BYTES 4096u
#define ARTIFACT_HEADER_BYTES 32u

static int write_all(int fd, const unsigned char *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(fd, buffer + offset, length - offset);
    if (written <= 0) return -1;
    offset += (size_t)written;
  }
  return 0;
}

static void put_u32(unsigned char *buffer, uint32_t value) {
  buffer[0] = (unsigned char)(value >> 24);
  buffer[1] = (unsigned char)(value >> 16);
  buffer[2] = (unsigned char)(value >> 8);
  buffer[3] = (unsigned char)value;
}

static void put_u64(unsigned char *buffer, uint64_t value) {
  for (int index = 7; index >= 0; --index) {
    buffer[index] = (unsigned char)value;
    value >>= 8;
  }
}

static int safe_component_path(const char *root, const char *path) {
  const size_t root_length = strlen(root);
  if (root_length == 0 || strncmp(root, path, root_length) != 0 || path[root_length] != '/') return -1;
  const char *cursor = path + root_length + 1;
  if (*cursor == '\0') return -1;
  while (*cursor != '\0') {
    const char *end = strchr(cursor, '/');
    const size_t length = end == NULL ? strlen(cursor) : (size_t)(end - cursor);
    if (length == 0 || (length == 1 && cursor[0] == '.')
        || (length == 2 && cursor[0] == '.' && cursor[1] == '.')) return -1;
    cursor = end == NULL ? cursor + length : end + 1;
  }
  return 0;
}

static int safe_link_target(const char *target, size_t length) {
  if (length == 0 || target[0] == '/') return -1;
  size_t offset = 0;
  while (offset < length) {
    size_t end = offset;
    while (end < length && target[end] != '/') ++end;
    const size_t component_length = end - offset;
    if (component_length == 0
        || (component_length == 1 && target[offset] == '.')
        || (component_length == 2 && target[offset] == '.' && target[offset + 1] == '.')) return -1;
    offset = end + 1;
  }
  return 0;
}

static int valid_regular(const struct stat *stats, uid_t execution_uid, uint64_t *size) {
  if (!S_ISREG(stats->st_mode) || (stats->st_mode & 07777u) == 0u
      || (stats->st_mode & 06000u) != 0u || stats->st_uid != execution_uid
      || stats->st_nlink != 1u || stats->st_size < 0
      || (uint64_t)stats->st_size > ARTIFACT_MAX_FILE_BYTES) return -1;
  *size = (uint64_t)stats->st_size;
  return 0;
}

static int same_identity(const struct stat *before, const struct stat *after) {
  return before->st_dev == after->st_dev && before->st_ino == after->st_ino
    && before->st_mode == after->st_mode && before->st_uid == after->st_uid
    && before->st_nlink == after->st_nlink && before->st_size == after->st_size;
}

int main(void) {
  const char *root = getenv("DEVSPACE_ARTIFACT_ROOT");
  const char *path = getenv("DEVSPACE_ARTIFACT_TARGET");
  if (root == NULL || path == NULL || safe_component_path(root, path) != 0) return 1;

  const uid_t execution_uid = geteuid();
  struct stat before;
  struct stat after;
  if (lstat(path, &before) != 0) return 1;

  unsigned char header[ARTIFACT_HEADER_BYTES];
  memset(header, 0, sizeof(header));
  memcpy(header, "DSARTF01", 8);
  put_u32(header + 8, 1u);

  if (S_ISLNK(before.st_mode)) {
    char target[ARTIFACT_MAX_LINK_BYTES + 1];
    ssize_t length = readlink(path, target, ARTIFACT_MAX_LINK_BYTES + 1);
    if (length <= 0 || (size_t)length > ARTIFACT_MAX_LINK_BYTES
        || safe_link_target(target, (size_t)length) != 0 || lstat(path, &after) != 0
        || !same_identity(&before, &after)) return 1;
    put_u32(header + 12, 2u);
    put_u32(header + 16, (uint32_t)(before.st_mode & 0777u));
    put_u64(header + 24, (uint64_t)length);
    if (write_all(STDOUT_FILENO, header, sizeof(header)) != 0
        || write_all(STDOUT_FILENO, (unsigned char *)target, (size_t)length) != 0) return 1;
    return 0;
  }

  uint64_t size = 0;
  if (valid_regular(&before, execution_uid, &size) != 0) return 1;
  int file = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (file < 0) return 1;
  if (fstat(file, &before) != 0 || valid_regular(&before, execution_uid, &size) != 0) {
    close(file);
    return 1;
  }
  unsigned char *bytes = malloc((size_t)size);
  if (bytes == NULL && size != 0) {
    close(file);
    return 1;
  }
  size_t offset = 0;
  while (offset < (size_t)size) {
    ssize_t count = read(file, bytes + offset, (size_t)size - offset);
    if (count <= 0) {
      free(bytes);
      close(file);
      return 1;
    }
    offset += (size_t)count;
  }
  if (fstat(file, &after) != 0 || valid_regular(&after, execution_uid, &size) != 0
      || !same_identity(&before, &after) || close(file) != 0) {
    free(bytes);
    return 1;
  }
  put_u32(header + 12, 1u);
  put_u32(header + 16, (uint32_t)(before.st_mode & 0777u));
  put_u64(header + 24, size);
  const int result = write_all(STDOUT_FILENO, header, sizeof(header)) == 0
    && write_all(STDOUT_FILENO, bytes, (size_t)size) == 0 ? 0 : 1;
  free(bytes);
  return result;
}
