import { adapterMain } from "../../provider-adapter-cli.mjs";

process.exitCode = await adapterMain(new URL("./adapter.json", import.meta.url));
