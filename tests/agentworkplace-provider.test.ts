import { describe, expect, test } from "bun:test"
import { verifyAgentWorkplaceContracts } from "../scripts/check-agentworkplace-contracts.ts"
import {
  buildFmxProviderManifest,
  canonicalProviderJson,
  FMX_EXPECTED_SKIPS,
  skipSetsMatch,
} from "../scripts/generate-agentworkplace-provider.ts"
import { environmentWithoutGitOverrides } from "../scripts/provider-repository-snapshot.ts"

describe("AgentWorkplace Phase 0 fmx provider adapter", () => {
  test("renders AgentWorkplace canonical provider JSON", () => {
    expect(
      canonicalProviderJson({
        z: ["one", "two"],
        a: { z: true, a: 1 },
      }),
    ).toBe(`{
  "a": {
    "a": 1,
    "z": true
  },
  "z": ["one", "two"]
}
`)
  })

  test("pins the exact hermetic Git subprocess environment", () => {
    expect(
      environmentWithoutGitOverrides({
        GIT_ATTR_NOSYSTEM: "0",
        GIT_CEILING_DIRECTORIES: "/poisoned-ceiling",
        GIT_CONFIG_GLOBAL: "/poisoned-global",
        GIT_CONFIG_NOSYSTEM: "0",
        GIT_CONFIG_SYSTEM: "/poisoned-system",
        GIT_DIR: "/poisoned-git-dir",
        GIT_INDEX_FILE: "/poisoned-index",
        GIT_NO_REPLACE_OBJECTS: "0",
        GIT_SSH_COMMAND: "poisoned-ssh",
        GIT_WORK_TREE: "/poisoned-worktree",
        HOME: "/preserved-home",
        PATH: "/preserved-path",
        XDG_CONFIG_HOME: "/preserved-xdg",
      }),
    ).toEqual({
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      HOME: "/preserved-home",
      PATH: "/preserved-path",
      XDG_CONFIG_HOME: "/preserved-xdg",
    })
  })

  test("maps every exact owner family and accounts for all 18 skips", async () => {
    const verification = await verifyAgentWorkplaceContracts()
    const manifest = buildFmxProviderManifest({
      actualSkipDescriptions: FMX_EXPECTED_SKIPS.map(
        ({ description }) => description,
      ),
      consumedRuntimeRegistrationDigest:
        "sha256:92a3e113ef3a4fa032da8679eb2631c4f4f8b07ec689a7d260aee92af12733e6",
      gateExitStatus: 0,
      repositorySha: "f".repeat(40),
      verification,
    })
    expect(manifest.contracts.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "fmx.runtime-extension-protocol", kind: "protocol" },
      { id: "fmx.agent-defaults", kind: "schema" },
      { id: "fmx.ensure-lifecycle", kind: "protocol" },
      { id: "fmx.fx-launch-admission", kind: "protocol" },
    ])
    expect(manifest.contracts.map(({ artifacts }) => artifacts[0]?.digest)).toEqual([
      "sha256:0ae7816c752eadf31dfa47651f0e37d64d72d272624046903b9f3519d982b88d",
      "sha256:d9f9858ad5a8593bdb7f8833d23da043b7b364673baaed32d2f24f1db6910265",
      "sha256:97c7bbd64cb81186f2bfc8268be48e6152955d0ed6f2336b4061004df93c93a2",
      "sha256:b807e31bf8f4de4179b91cca4c9f3a9a40d572f98d8e5467242fc70908eb8161",
    ])
    expect(manifest.skips.expected).toHaveLength(18)
    expect(manifest.skips.actual).toEqual(manifest.skips.expected)
    expect(skipSetsMatch(manifest)).toBe(true)
    for (const contract of manifest.contracts) {
      expect(contract.digest).toMatch(/^sha256:[0-9a-f]{64}$/u)
    }
  })

  test("refuses skip drift semantically", async () => {
    const verification = await verifyAgentWorkplaceContracts()
    const manifest = buildFmxProviderManifest({
      actualSkipDescriptions: [],
      consumedRuntimeRegistrationDigest:
        "sha256:92a3e113ef3a4fa032da8679eb2631c4f4f8b07ec689a7d260aee92af12733e6",
      gateExitStatus: 0,
      repositorySha: "e".repeat(40),
      verification,
    })
    expect(skipSetsMatch(manifest)).toBe(false)
  })
})
