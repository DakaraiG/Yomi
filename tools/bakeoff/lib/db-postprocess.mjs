// Re-export of the shipping implementation.
//
// This file used to hold the code. It moved into extension/lib/ when the
// detector became something the extension runs rather than something the
// harness demonstrates, and re-exporting is what keeps the bake-off measuring
// the code that actually ships. A copy here would drift, and the drift would be
// invisible: the harness would keep reporting numbers for an implementation
// nobody uses.

export { probabilityMapToBoxes, mergeIntoBlocks } from "../../../extension/lib/db-postprocess.js";
