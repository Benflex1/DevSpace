#define _GNU_SOURCE

#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define ARTIFACT_MAX_FILE_BYTES (512u * 1024u * 1024u)
#define ARTIFACT_MAX_LINK_BYTES 4096u
#define ARTIFACT_HEADER_BYTES 32u
#define ARTIFACT_TREE_HEADER_BYTES 20u
#define ARTIFACT_TREE_MAX_ENTRIES 16384u
#define ARTIFACT_TREE_MAX_OUTPUT_BYTES (2u * 1024u * 1024u)
#define ARTIFACT_TREE_MAX_DEPTH 128u
#define ARTIFACT_TREE_MAX_PATH_BYTES 16384u

static unsigned char tree_output[ARTIFACT_TREE_MAX_OUTPUT_BYTES];
static size_t tree_output_length = ARTIFACT_TREE_HEADER_BYTES;
static uint32_t tree_entry_count = 0u;

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

static int open_absolute_directory_nofollow(const char *path) {
  if (path == NULL || path[0] != '/' || path[1] == '\0') return -1;
  const size_t path_length = strlen(path);
  if (path_length > ARTIFACT_TREE_MAX_PATH_BYTES || path[path_length - 1u] == '/') return -1;
  int current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (current < 0) return -1;
  size_t offset = 1u;
  while (offset < path_length) {
    size_t end = offset;
    while (end < path_length && path[end] != '/') ++end;
    const size_t component_length = end - offset;
    if (component_length == 0u || component_length > NAME_MAX
        || (component_length == 1u && path[offset] == '.')
        || (component_length == 2u && path[offset] == '.' && path[offset + 1u] == '.')) {
      close(current);
      return -1;
    }
    char component[NAME_MAX + 1u];
    memcpy(component, path + offset, component_length);
    component[component_length] = '\0';
    int next = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) {
      close(current);
      return -1;
    }
    close(current);
    current = next;
    offset = end + 1u;
  }
  return current;
}

static int open_target_parent(const char *root, const char *path, char *basename, size_t capacity) {
  if (safe_component_path(root, path) != 0) return -1;
  int current = open_absolute_directory_nofollow(root);
  if (current < 0) return -1;
  const char *relative = path + strlen(root) + 1u;
  const size_t relative_length = strlen(relative);
  if (relative_length == 0u || relative_length > ARTIFACT_TREE_MAX_PATH_BYTES) {
    close(current);
    return -1;
  }
  char copy[ARTIFACT_TREE_MAX_PATH_BYTES + 1u];
  memcpy(copy, relative, relative_length + 1u);
  char *last_separator = strrchr(copy, '/');
  char *leaf = copy;
  if (last_separator != NULL) {
    *last_separator = '\0';
    leaf = last_separator + 1u;
    char *component = copy;
    for (;;) {
      char *separator = strchr(component, '/');
      if (separator != NULL) *separator = '\0';
      if (strlen(component) > NAME_MAX) {
        close(current);
        return -1;
      }
      int next = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (next < 0) {
        close(current);
        return -1;
      }
      close(current);
      current = next;
      if (separator == NULL) break;
      component = separator + 1u;
    }
  }
  const size_t leaf_length = strlen(leaf);
  if (leaf_length == 0u || leaf_length > NAME_MAX || leaf_length >= capacity) {
    close(current);
    return -1;
  }
  memcpy(basename, leaf, leaf_length + 1u);
  return current;
}

static int append_tree_entry(uint32_t kind, const char *relative_path) {
  const size_t path_length = strlen(relative_path);
  if (path_length == 0u || path_length > ARTIFACT_TREE_MAX_PATH_BYTES
      || tree_entry_count >= ARTIFACT_TREE_MAX_ENTRIES
      || tree_output_length + 8u + path_length > ARTIFACT_TREE_MAX_OUTPUT_BYTES) return -1;
  put_u32(tree_output + tree_output_length, kind);
  put_u32(tree_output + tree_output_length + 4u, (uint32_t)path_length);
  memcpy(tree_output + tree_output_length + 8u, relative_path, path_length);
  tree_output_length += 8u + path_length;
  ++tree_entry_count;
  return 0;
}

static int walk_tree(int directory_fd, const char *prefix, unsigned int depth) {
  if (depth > ARTIFACT_TREE_MAX_DEPTH) return -1;
  DIR *directory = fdopendir(dup(directory_fd));
  if (directory == NULL) return -1;
  errno = 0;
  struct dirent *entry;
  int result = 0;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    const size_t name_length = strlen(entry->d_name);
    if (name_length == 0u || name_length > NAME_MAX || strchr(entry->d_name, '/') != NULL) {
      result = -1;
      break;
    }
    char relative[ARTIFACT_TREE_MAX_PATH_BYTES + 1u];
    const int formatted = prefix[0] == '\0'
      ? snprintf(relative, sizeof(relative), "%s", entry->d_name)
      : snprintf(relative, sizeof(relative), "%s/%s", prefix, entry->d_name);
    if (formatted < 0 || (size_t)formatted >= sizeof(relative)) {
      result = -1;
      break;
    }
    struct stat before;
    if (fstatat(directory_fd, entry->d_name, &before, AT_SYMLINK_NOFOLLOW) != 0) {
      result = -1;
      break;
    }
    const uint32_t kind = S_ISDIR(before.st_mode) ? 1u
      : S_ISREG(before.st_mode) ? 2u
      : S_ISLNK(before.st_mode) ? 3u : 4u;
    if (append_tree_entry(kind, relative) != 0) {
      result = -1;
      break;
    }
    if (S_ISDIR(before.st_mode)) {
      int child_fd = openat(directory_fd, entry->d_name,
        O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      struct stat opened;
      if (child_fd < 0 || fstat(child_fd, &opened) != 0 || !same_identity(&before, &opened)
          || walk_tree(child_fd, relative, depth + 1u) != 0) {
        if (child_fd >= 0) close(child_fd);
        result = -1;
        break;
      }
      close(child_fd);
    }
    struct stat after;
    if (fstatat(directory_fd, entry->d_name, &after, AT_SYMLINK_NOFOLLOW) != 0
        || !same_identity(&before, &after)) {
      result = -1;
      break;
    }
    errno = 0;
  }
  if (result == 0 && errno != 0) result = -1;
  if (closedir(directory) != 0) result = -1;
  return result;
}

static int write_tree_result(uint32_t status) {
  memcpy(tree_output, "DSARTL01", 8u);
  put_u32(tree_output + 8u, 1u);
  put_u32(tree_output + 12u, status);
  put_u32(tree_output + 16u, tree_entry_count);
  return write_all(STDOUT_FILENO, tree_output, tree_output_length);
}

static int enumerate_tree(const char *root) {
  int root_fd = open_absolute_directory_nofollow(root);
  if (root_fd < 0) {
    if (errno == ENOENT) return write_tree_result(1u);
    return 1;
  }
  struct stat before;
  struct stat after;
  int result = fstat(root_fd, &before);
  if (result == 0 && !S_ISDIR(before.st_mode)) result = -1;
  if (result == 0) result = walk_tree(root_fd, "", 0u);
  if (result == 0 && (fstat(root_fd, &after) != 0 || !same_identity(&before, &after))) result = -1;
  if (close(root_fd) != 0) result = -1;
  if (result != 0) return 1;
  return write_tree_result(0u);
}

static int read_entry(const char *root, const char *path) {
  char basename[NAME_MAX + 1u];
  int parent_fd = open_target_parent(root, path, basename, sizeof(basename));
  if (parent_fd < 0) return 1;
  struct stat before;
  struct stat after;
  if (fstatat(parent_fd, basename, &before, AT_SYMLINK_NOFOLLOW) != 0) {
    close(parent_fd);
    return 1;
  }

  unsigned char header[ARTIFACT_HEADER_BYTES];
  memset(header, 0, sizeof(header));
  memcpy(header, "DSARTF01", 8);
  put_u32(header + 8, 1u);
  if (S_ISLNK(before.st_mode)) {
    char target[ARTIFACT_MAX_LINK_BYTES + 1];
    ssize_t length = readlinkat(parent_fd, basename, target, ARTIFACT_MAX_LINK_BYTES + 1);
    if (length <= 0 || (size_t)length > ARTIFACT_MAX_LINK_BYTES
        || safe_link_target(target, (size_t)length) != 0
        || fstatat(parent_fd, basename, &after, AT_SYMLINK_NOFOLLOW) != 0 || !same_identity(&before, &after)) {
      close(parent_fd);
      return 1;
    }
    put_u32(header + 12, 2u);
    put_u32(header + 16, (uint32_t)(before.st_mode & 0777u));
    put_u64(header + 24, (uint64_t)length);
    const int result = write_all(STDOUT_FILENO, header, sizeof(header)) == 0
      && write_all(STDOUT_FILENO, (unsigned char *)target, (size_t)length) == 0 ? 0 : 1;
    close(parent_fd);
    return result;
  }

  uint64_t size = 0;
  if (valid_regular(&before, geteuid(), &size) != 0) {
    close(parent_fd);
    return 1;
  }
  int file = openat(parent_fd, basename, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (file < 0) {
    close(parent_fd);
    return 1;
  }
  if (fstat(file, &after) != 0 || valid_regular(&after, geteuid(), &size) != 0
      || !same_identity(&before, &after)) {
    close(file);
    close(parent_fd);
    return 1;
  }
  unsigned char *bytes = malloc((size_t)size);
  if (bytes == NULL && size != 0) {
    close(file);
    close(parent_fd);
    return 1;
  }
  size_t offset = 0;
  while (offset < (size_t)size) {
    ssize_t count = read(file, bytes + offset, (size_t)size - offset);
    if (count <= 0) {
      free(bytes);
      close(file);
      close(parent_fd);
      return 1;
    }
    offset += (size_t)count;
  }
  if (fstat(file, &after) != 0 || valid_regular(&after, geteuid(), &size) != 0
      || !same_identity(&before, &after) || close(file) != 0
      || fstatat(parent_fd, basename, &after, AT_SYMLINK_NOFOLLOW) != 0 || !same_identity(&before, &after)) {
    free(bytes);
    close(parent_fd);
    return 1;
  }
  put_u32(header + 12, 1u);
  put_u32(header + 16, (uint32_t)(before.st_mode & 0777u));
  put_u64(header + 24, size);
  const int result = write_all(STDOUT_FILENO, header, sizeof(header)) == 0
    && write_all(STDOUT_FILENO, bytes, (size_t)size) == 0 ? 0 : 1;
  free(bytes);
  close(parent_fd);
  return result;
}

int main(void) {
  const char *root = getenv("DEVSPACE_ARTIFACT_ROOT");
  const char *path = getenv("DEVSPACE_ARTIFACT_TARGET");
  if (root == NULL) return 1;
  const char *mode = getenv("DEVSPACE_ARTIFACT_MODE");
  if (mode != NULL && strcmp(mode, "tree") == 0) return enumerate_tree(root);
  if (path == NULL || safe_component_path(root, path) != 0) return 1;
  return read_entry(root, path);
}
