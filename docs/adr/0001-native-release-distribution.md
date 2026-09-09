# Native release distribution

Status: superseded by [ADR 0028](0028-source-only-installation.md), Source-only installation.

smolmux is distributed as four native Bun-compiled binaries—Linux and macOS on x86_64 and arm64—rather than through npm, because installation should require only one shell command and no JavaScript runtime. Versioned `.tar.xz` archives with `.tar.gz` fallbacks and separate SHA-256 files live in public Vercel Blob storage; `latest.txt` is updated only after every target passes native tests. The installer verifies the checksum before atomically placing `smolmux` in `${SMOLMUX_INSTALL_DIR:-$HOME/.local/bin}`.
