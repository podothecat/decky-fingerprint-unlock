import deckyPlugin from "@decky/rollup";

// @decky/rollup exports the config factory as a default, not a named `deckyPlugin`.
// It reads plugin.json itself for the manifest, wipes dist/ before each build, and maps
// react -> SP_REACT and @decky/ui -> DFL as external globals.
export default deckyPlugin({});
