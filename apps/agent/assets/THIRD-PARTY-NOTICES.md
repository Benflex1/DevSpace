# Terminal runtime assets

DevSpace packages the Linux x86_64 static tmux 3.7c binary from the official
[tmux-builds v3.7c release](https://github.com/tmux/tmux-builds/releases/tag/v3.7c).
The archive SHA-256 is `cc56bd1cc873eb6089c615f0496b072385bda8a6d944069f38564a5d49c128aa`;
the extracted binary SHA-256 is `7d0f1e85c5b11df7fe127ab90674c6a15663ad72a25fcf7fabadba6bbb0b29d5`.

That release was built with the versions pinned in the release commit's `versions.env`:

- musl 1.2.5
- libevent 2.1.12
- ncurses 6.5
- utf8proc 2.11.2

Their corresponding license notices and tmux's per-file license are in `licenses/`.
The bundled `xterm-256color` and `tmux-256color` terminfo entries are compiled ncurses data;
their SHA-256 digests are verified by the Agent before staging.
