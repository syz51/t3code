export interface ReferenceRepo {
  readonly id: string;
  readonly prefix: string;
  readonly repository: string;
  readonly latestRef: string;
  readonly versionSourcePath: string;
  readonly packageVersionPath: ReadonlyArray<string>;
  readonly versionTagPrefix: string;
}

export const referenceRepos: ReadonlyArray<ReferenceRepo> = [
  {
    id: "effect",
    prefix: ".repos/effect",
    repository: "https://github.com/Effect-TS/effect.git",
    latestRef: "main",
    versionSourcePath: "package.json",
    packageVersionPath: ["workspaces", "catalog", "effect"],
    versionTagPrefix: "effect@",
  },
  {
    id: "alchemy-effect",
    prefix: ".repos/alchemy-effect",
    repository: "https://github.com/alchemy-run/alchemy-effect.git",
    latestRef: "main",
    versionSourcePath: "package.json",
    packageVersionPath: ["workspaces", "catalog", "alchemy"],
    versionTagPrefix: "v",
  },
];
