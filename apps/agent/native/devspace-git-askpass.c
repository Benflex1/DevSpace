#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#define FRAME_MAX_BYTES (128u * 1024u)
#define PROMPT_MAX_BYTES (8u * 1024u)
#define CAPABILITY_BYTES 64u
#define EXECUTION_MAX_BYTES 128u
#define CREDENTIAL_MAX_BYTES (16u * 1024u)

static const unsigned char REQUEST_MAGIC[8] = {'D','S','A','S','K','P','0','1'};
static const unsigned char RESPONSE_MAGIC[8] = {'D','S','A','S','K','R','0','1'};

static int read_all(int fd, unsigned char *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = read(fd, buffer + offset, length - offset);
    if (count <= 0) return -1;
    offset += (size_t)count;
  }
  return 0;
}

static int write_all(int fd, const unsigned char *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = write(fd, buffer + offset, length - offset);
    if (count <= 0) return -1;
    offset += (size_t)count;
  }
  return 0;
}

static uint32_t read_u32(const unsigned char *buffer) {
  return ((uint32_t)buffer[0] << 24) | ((uint32_t)buffer[1] << 16)
    | ((uint32_t)buffer[2] << 8) | (uint32_t)buffer[3];
}

static void put_u32(unsigned char *buffer, uint32_t value) {
  buffer[0] = (unsigned char)(value >> 24);
  buffer[1] = (unsigned char)(value >> 16);
  buffer[2] = (unsigned char)(value >> 8);
  buffer[3] = (unsigned char)value;
}

static void put_u16(unsigned char *buffer, uint16_t value) {
  buffer[0] = (unsigned char)(value >> 8);
  buffer[1] = (unsigned char)value;
}

static int bounded_strlen(const char *value, size_t maximum, size_t *length) {
  if (value == NULL) return -1;
  size_t result = strnlen(value, maximum + 1u);
  if (result == 0 || result > maximum) return -1;
  *length = result;
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 2) return 1;
  const char *socket_path = getenv("DEVSPACE_GIT_ASKPASS_SOCKET");
  const char *capability = getenv("DEVSPACE_GIT_ASKPASS_CAPABILITY");
  const char *execution_id = getenv("DEVSPACE_GIT_ASKPASS_EXECUTION_ID");
  if (socket_path == NULL || capability == NULL || execution_id == NULL) return 1;

  size_t socket_length = 0;
  size_t capability_length = 0;
  size_t execution_length = 0;
  size_t prompt_length = 0;
  if (bounded_strlen(socket_path, sizeof(((struct sockaddr_un *)0)->sun_path) - 1u, &socket_length) != 0
      || bounded_strlen(capability, CAPABILITY_BYTES, &capability_length) != 0
      || capability_length != CAPABILITY_BYTES
      || bounded_strlen(execution_id, EXECUTION_MAX_BYTES, &execution_length) != 0
      || bounded_strlen(argv[1], PROMPT_MAX_BYTES, &prompt_length) != 0) return 1;

  int socket_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (socket_fd < 0) return 1;
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  memcpy(address.sun_path, socket_path, socket_length);
  address.sun_path[socket_length] = '\0';
  if (connect(socket_fd, (const struct sockaddr *)&address, sizeof(address)) != 0) {
    close(socket_fd);
    return 1;
  }

  const size_t payload_length = 28u + capability_length + execution_length + prompt_length;
  if (payload_length > FRAME_MAX_BYTES) { close(socket_fd); return 1; }
  unsigned char *payload = calloc(1, payload_length);
  if (payload == NULL) { close(socket_fd); return 1; }
  memcpy(payload, REQUEST_MAGIC, 8u);
  put_u32(payload + 8u, 1u);
  put_u32(payload + 12u, (uint32_t)getpid());
  put_u32(payload + 16u, (uint32_t)getpgrp());
  put_u16(payload + 20u, (uint16_t)capability_length);
  put_u16(payload + 22u, (uint16_t)execution_length);
  put_u32(payload + 24u, (uint32_t)prompt_length);
  memcpy(payload + 28u, capability, capability_length);
  memcpy(payload + 28u + capability_length, execution_id, execution_length);
  memcpy(payload + 28u + capability_length + execution_length, argv[1], prompt_length);
  unsigned char header[4];
  put_u32(header, (uint32_t)payload_length);
  int result = write_all(socket_fd, header, sizeof(header)) == 0
    && write_all(socket_fd, payload, payload_length) == 0;
  free(payload);
  if (!result) { close(socket_fd); return 1; }
  if (shutdown(socket_fd, SHUT_WR) != 0) { close(socket_fd); return 1; }

  unsigned char response_header[4];
  if (read_all(socket_fd, response_header, sizeof(response_header)) != 0) { close(socket_fd); return 1; }
  uint32_t response_length = read_u32(response_header);
  if (response_length < 20u || response_length > FRAME_MAX_BYTES) { close(socket_fd); return 1; }
  unsigned char *response = malloc(response_length);
  if (response == NULL) { close(socket_fd); return 1; }
  if (read_all(socket_fd, response, response_length) != 0
      || memcmp(response, RESPONSE_MAGIC, 8u) != 0
      || read_u32(response + 8u) != 1u
      || read_u32(response + 12u) != 0u) {
    free(response);
    close(socket_fd);
    return 1;
  }
  uint32_t credential_length = read_u32(response + 16u);
  if (credential_length == 0u || credential_length > CREDENTIAL_MAX_BYTES
      || response_length != 20u + credential_length) {
    free(response);
    close(socket_fd);
    return 1;
  }
  result = write_all(STDOUT_FILENO, response + 20u, credential_length) == 0;
  free(response);
  if (close(socket_fd) != 0) result = 0;
  return result ? 0 : 1;
}
