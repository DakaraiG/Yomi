// The candidate roster.
//
// maxSide is swept rather than fixed because it is the setting most likely to be
// blamed on the model. A candidate that looks hopeless at 960 and fine at 2048
// has told you about resolution, not about architecture, and the bake-off has to
// tell those apart.

import classical from "./classical.mjs";
import { paddleCandidate } from "./paddle-db.mjs";
import { craftCandidate } from "./craft.mjs";
import { ctdCandidate } from "./ctd.mjs";

export const CANDIDATES = {
  classical,

  "paddle-960": paddleCandidate({ maxSide: 960, label: "paddle-960" }),
  "paddle-1536": paddleCandidate({ maxSide: 1536, label: "paddle-1536" }),
  "paddle-2048": paddleCandidate({ maxSide: 2048, label: "paddle-2048" }),

  // Same architecture, ~24x the weights. Not shippable at 113MB; it is here to
  // separate "the mobile model is too small" from "DB is the wrong approach for
  // manga", which are different problems with different answers.
  "paddle-server-1536": paddleCandidate({
    key: "paddle-v4-server", maxSide: 1536, label: "paddle-server-1536"
  }),

  "craft-1536": craftCandidate({ maxSide: 1536, label: "craft-1536" }),
  "craft-2048": craftCandidate({ maxSide: 2048, label: "craft-2048" }),

  // GPL-3.0, and on the roster for its segmentation head rather than for its
  // boxes -- see fetch-models.mjs. Note that this model produced
  // fixtures/baseline.json: a recall number well under 100% is a bug in
  // candidates/ctd.mjs, not a finding about the model. The two heads are
  // separate entries because they answer different questions -- blk returns
  // BLOCKS, the baseline's own granularity, det returns lines like everything
  // else here.
  "ctd-blk": ctdCandidate({ head: "blk", label: "ctd-blk" }),
  "ctd-det": ctdCandidate({ head: "det", label: "ctd-det" }),
  "ctd-union": ctdCandidate({ head: "union", label: "ctd-union" }),
  "ctd-fused": ctdCandidate({ head: "fused", label: "ctd-fused" })
};

export const DEFAULT_SET = [
  "classical", "paddle-960", "paddle-1536", "paddle-2048",
  "paddle-server-1536", "craft-1536", "craft-2048"
];
