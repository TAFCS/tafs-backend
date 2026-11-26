/**
 * manifest.json as published by tafs-software-manual/scripts/manifest.py
 * (schema 1). The manual repo is the source of truth for this shape.
 */
export type GuideFile = { file: string; bytes: number; pages: number | null };

export type GuideModule = {
  /** `area/module`, e.g. `finance/defaulters-report`. */
  id: string;
  title: string;
  /** Where to find it in the app, e.g. `Finance → Financial Reports → Defaulters`. */
  where: string;
  summary: string | null;
  /** The module on its own: cover, contents, content. */
  pdf: GuideFile;
  /** The module with no cover or contents, for joining. */
  bare: GuideFile;
};

export type GuideArea = { id: string; title: string; pdf: GuideFile; modules: GuideModule[] };

export type GuideManifest = {
  schema: number;
  title: string;
  built_at: string;
  commit: string | null;
  manual: GuideFile;
  areas: GuideArea[];
};

export type GuideRelease = {
  tag: string;
  published_at: string | null;
  manifest: GuideManifest;
  /** Release asset name -> asset id. */
  assets: Map<string, number>;
};
