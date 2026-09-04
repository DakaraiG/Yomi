// Re-export of the shipping implementation.
//
// Re-exported rather than copied so the bake-off measures the code that ships:
// a copy would drift invisibly, with the harness reporting numbers for an
// implementation nobody uses.

export { probabilityMapToBoxes, mergeIntoBlocks } from "../../../extension/lib/db-postprocess.js";
