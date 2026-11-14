// Mirrors worker/src/lsworker/extract.py kind_for(). Keep the two in sync.
export type Kind = "document" | "image" | "code" | "text" | "media" | "archive" | "other";

const MAP: Record<string, Kind> = {};
const add = (kind: Kind, exts: string) => exts.split(" ").forEach((e) => (MAP["." + e] = kind));
add("document", "pdf docx");
add("image", "png jpg jpeg webp bmp tif tiff gif");
add(
  "code",
  "py ts tsx js jsx mjs cjs go rs java kt c h cpp hpp cs rb php swift sh ps1 bat sql lua r scala css scss html vue svelte",
);
add("text", "txt md markdown csv tsv json yaml yml toml ini log xml rst tex org");
add("media", "mp3 wav flac m4a aac ogg mp4 mkv mov avi webm heic heif raw cr2 nef");
add("archive", "zip 7z rar tar gz bz2 xz iso");

/** Kinds v1 extracts. media/archive/other are counted by the census but not indexed. */
export const INDEXED_KINDS: ReadonlySet<Kind> = new Set(["document", "image", "code", "text"]);

export function kindFor(ext: string): Kind {
  return MAP[ext.toLowerCase()] ?? "other";
}
