# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `lib.static` function for registering pre-existing files/directories in the content store without running a command
- Hash verification for static entries against declared content hash
- Static entries preserved during `prune`
- Symlinks in `nix-workflow-output/` for static entries
- Documentation for `static` and `__toString` mechanism in `docs/concepts.rst`
- Tests for `extract_static_attrs` and `process_statics`
