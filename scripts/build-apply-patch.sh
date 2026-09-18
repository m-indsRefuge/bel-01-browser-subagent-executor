#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
codex_root_input="${1:-${CODEX_REPO:-"$repo_root/../codex"}}"
rust_toolchain="${RUST_TOOLCHAIN:-1.97.1}"

host_os="$(uname -s)"
host_arch="$(uname -m)"

case "$host_os:$host_arch" in
  Darwin:arm64|Darwin:x86_64)
    target_triples=("aarch64-apple-darwin" "x86_64-apple-darwin")
    output_name="apply_patch"
    provenance_name="provenance.json"
    build_kind="darwin-universal2"
    required_commands=(cargo git lipo node rustc rustup shasum strings strip)
    ;;
  Linux:x86_64)
    target_triples=("x86_64-unknown-linux-gnu")
    output_name="apply_patch-linux-x64"
    provenance_name="provenance-linux-x64.json"
    build_kind="linux-x64"
    required_commands=(cargo git node rustc rustup sha256sum strings strip stat)
    ;;
  *)
    echo "Unsupported apply_patch build host: $host_os/$host_arch" >&2
    echo "Supported hosts: macOS arm64/x86_64 and Linux x86_64." >&2
    exit 1
    ;;
esac

for required_command in "${required_commands[@]}"; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Required command not found: $required_command" >&2
    exit 1
  fi
done

if [[ ! -d "$codex_root_input" ]]; then
  echo "Codex repository not found: $codex_root_input" >&2
  echo "Usage: $0 /absolute/path/to/codex" >&2
  exit 1
fi

codex_root="$(cd -- "$codex_root_input" && pwd -P)"
source_manifest="$codex_root/codex-rs/Cargo.toml"

if [[ ! -f "$source_manifest" || ! -f "$codex_root/codex-rs/apply-patch/Cargo.toml" ]]; then
  echo "Not an OpenAI Codex checkout with the codex-apply-patch crate: $codex_root" >&2
  exit 1
fi

source_commit="$(git -C "$codex_root" rev-parse HEAD)"
source_repository="$(git -C "$codex_root" remote get-url origin 2>/dev/null || printf 'unknown')"

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/codex-apply-patch.XXXXXX")"
source_worktree="$temporary_root/codex"
target_dir="$temporary_root/target"
vendor_dir="$repo_root/vendor/apply-patch"

mkdir -p "$vendor_dir"

temporary_binary="$(mktemp "$vendor_dir/.apply_patch.XXXXXX")"
temporary_provenance="$(mktemp "$vendor_dir/.provenance.XXXXXX")"
worktree_added=false

cleanup() {
  rm -f "$temporary_binary" "$temporary_provenance"
  if [[ "$worktree_added" == true ]]; then
    git -C "$codex_root" worktree remove --force "$source_worktree" >/dev/null 2>&1 || true
  fi
  rm -rf "$temporary_root"
}
trap cleanup EXIT

git -C "$codex_root" worktree add --detach "$source_worktree" "$source_commit"
worktree_added=true

manifest="$source_worktree/codex-rs/Cargo.toml"

rustup target add --toolchain "$rust_toolchain" "${target_triples[@]}"

slice_binaries=()

for target_triple in "${target_triples[@]}"; do
  RUSTFLAGS="--remap-path-prefix=$HOME=/build/home --remap-path-prefix=$source_worktree=/build/codex" \
    CARGO_TARGET_DIR="$target_dir" \
    cargo +"$rust_toolchain" build \
      --manifest-path "$manifest" \
      --package codex-apply-patch \
      --bin apply_patch \
      --release \
      --target "$target_triple"

  built_binary="$target_dir/$target_triple/release/apply_patch"

  if [[ ! -x "$built_binary" ]]; then
    echo "Build completed without an executable at $built_binary" >&2
    exit 1
  fi

  if [[ "$host_os" == "Darwin" ]]; then
    strip -x "$built_binary"
  else
    strip "$built_binary"
  fi

  slice_binaries+=("$built_binary")
done

if [[ "$host_os" == "Darwin" ]]; then
  lipo -create "${slice_binaries[@]}" -output "$temporary_binary"

  architectures="$(lipo -archs "$temporary_binary")"
  if [[ "$architectures" != *"arm64"* || "$architectures" != *"x86_64"* ]]; then
    echo "Universal binary is missing a required architecture: $architectures" >&2
    exit 1
  fi

  build_command="cargo build --package codex-apply-patch --bin apply_patch --release --target <target>; lipo -create <slices> -output apply_patch"
else
  cp "${slice_binaries[0]}" "$temporary_binary"
  architectures="x86_64"
  build_command="cargo build --package codex-apply-patch --bin apply_patch --release --target x86_64-unknown-linux-gnu"
fi

chmod 0755 "$temporary_binary"

if strings "$temporary_binary" | grep -Eq '(/Users/[^/]+/|/home/[^/]+/)'; then
  echo "Vendored binary contains a host user-home path after remapping." >&2
  exit 1
fi

if [[ "$host_os" == "Darwin" ]]; then
  sha256="$(shasum -a 256 "$temporary_binary" | awk '{print $1}')"
  size_bytes="$(stat -f '%z' "$temporary_binary")"
else
  sha256="$(sha256sum "$temporary_binary" | awk '{print $1}')"
  size_bytes="$(stat -c '%s' "$temporary_binary")"
fi

rustc_version="$(rustc +"$rust_toolchain" --version)"
cargo_version="$(cargo +"$rust_toolchain" --version)"
targets_csv="$(IFS=,; echo "${target_triples[*]}")"

node - \
  "$temporary_provenance" \
  "$source_repository" \
  "$source_commit" \
  "$sha256" \
  "$size_bytes" \
  "$rustc_version" \
  "$cargo_version" \
  "$targets_csv" \
  "$build_command" \
  "$build_kind" <<'NODE'
const fs = require("node:fs")

const [
  output,
  sourceRepository,
  sourceCommit,
  sha256,
  sizeBytes,
  rustc,
  cargo,
  targetsCsv,
  buildCommand,
  buildKind,
] = process.argv.slice(2)

const provenance = {
  source_repository: sourceRepository,
  source_commit: sourceCommit,
  crate: "codex-apply-patch",
  binary: "apply_patch",
  build_kind: buildKind,
  targets: targetsCsv.split(","),
  build_command: buildCommand,
  build_environment: {
    CARGO_TARGET_DIR: "<temporary>",
    RUSTFLAGS:
      "--remap-path-prefix=$HOME=/build/home --remap-path-prefix=$SOURCE_WORKTREE=/build/codex",
  },
  sha256,
  size_bytes: Number(sizeBytes),
  rustc,
  cargo,
}

fs.writeFileSync(output, `${JSON.stringify(provenance, null, 2)}\n`)
NODE

chmod 0644 "$temporary_provenance"

cp "$source_worktree/LICENSE" "$vendor_dir/LICENSE"
cp "$source_worktree/NOTICE" "$vendor_dir/NOTICE"

mv "$temporary_binary" "$vendor_dir/$output_name"
mv "$temporary_provenance" "$vendor_dir/$provenance_name"

echo "Vendored codex-apply-patch $source_commit"
echo "Binary: $vendor_dir/$output_name ($size_bytes bytes)"
echo "Target(s): ${target_triples[*]}"
echo "SHA-256: $sha256"
