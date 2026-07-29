#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define CODEX_AUTH_MAX_BYTES (64u * 1024u)
#define STAGED_READBACK_METADATA_BYTES 112u

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

static int valid_snapshot(const struct stat *stats, uid_t execution_uid, uint64_t *size) {
  if (!S_ISREG(stats->st_mode) || (stats->st_mode & 07777u) != 0600u
      || stats->st_uid != execution_uid || stats->st_nlink != 1u
      || stats->st_size <= 0 || (uint64_t)stats->st_size > CODEX_AUTH_MAX_BYTES) return -1;
  *size = (uint64_t)stats->st_size;
  return 0;
}

static void encode_snapshot(unsigned char *buffer, const struct stat *stats, uid_t execution_uid) {
  put_u64(buffer + 0, (uint64_t)stats->st_dev);
  put_u64(buffer + 8, (uint64_t)stats->st_ino);
  put_u64(buffer + 16, (uint64_t)stats->st_size);
  put_u64(buffer + 24, (uint64_t)stats->st_mode);
  put_u64(buffer + 32, (uint64_t)stats->st_uid);
  put_u64(buffer + 40, (uint64_t)stats->st_nlink);
  put_u64(buffer + 48, (uint64_t)execution_uid);
}

int main(void) {
  const char *path = getenv("DEVSPACE_TARGET_FILE");
  if (path == NULL || path[0] == '\0') return 1;

  const uid_t execution_uid = geteuid();
  int file = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (file < 0) return 1;

  struct stat before;
  struct stat after;
  uint64_t size = 0;
  if (fstat(file, &before) != 0 || valid_snapshot(&before, execution_uid, &size) != 0) {
    close(file);
    return 1;
  }

  unsigned char *bytes = malloc((size_t)size);
  if (bytes == NULL) {
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
  if (fstat(file, &after) != 0 || valid_snapshot(&after, execution_uid, &size) != 0) {
    free(bytes);
    close(file);
    return 1;
  }
  if (before.st_dev != after.st_dev || before.st_ino != after.st_ino || before.st_size != after.st_size
      || before.st_mode != after.st_mode || before.st_uid != after.st_uid || before.st_nlink != after.st_nlink) {
    free(bytes);
    close(file);
    return 1;
  }
  if (close(file) != 0) {
    free(bytes);
    return 1;
  }

  unsigned char header[20];
  memcpy(header, "DSAUTH01", 8);
  put_u32(header + 8, 1u);
  put_u32(header + 12, STAGED_READBACK_METADATA_BYTES);
  put_u32(header + 16, (uint32_t)size);
  unsigned char metadata[STAGED_READBACK_METADATA_BYTES];
  encode_snapshot(metadata, &before, execution_uid);
  encode_snapshot(metadata + 56, &after, execution_uid);
  if (write_all(STDOUT_FILENO, header, sizeof(header)) != 0
      || write_all(STDOUT_FILENO, metadata, sizeof(metadata)) != 0
      || write_all(STDOUT_FILENO, bytes, (size_t)size) != 0) {
    free(bytes);
    return 1;
  }
  free(bytes);
  return 0;
}
