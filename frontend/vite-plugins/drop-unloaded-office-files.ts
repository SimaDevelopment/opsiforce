import type { Plugin, Rolldown } from "vite";

const OFFICE_EMITTED = /^(?:docx_\w+_bg|ooxml_opc_bg|pptx_wasm_bg|xlsx_wasm_bg|residentEngineWorker)\b/;

type OutputFile = Rolldown.OutputChunk | Rolldown.OutputAsset;

const baseName = (file: OutputFile) => file.fileName.split("/").pop() ?? file.fileName;

const sourceText = (file: OutputFile) =>
  file.type === "chunk" ? file.code : typeof file.source === "string" ? file.source : "";

export function dropUnloadedOfficeFiles(): Plugin {
  return {
    name: "drop-unloaded-office-files",
    apply: "build",
    generateBundle: {
      order: "post",
      handler(_, bundle) {
        const files = Object.values(bundle).filter((file) => !file.fileName.endsWith(".map"));
        const named = (file: OutputFile) =>
          files.some((other) => other !== file && sourceText(other).includes(baseName(file)));

        files
          .filter((file) => OFFICE_EMITTED.test(baseName(file)) && !named(file))
          .forEach((file) => {
            delete bundle[file.fileName];
            delete bundle[`${file.fileName}.map`];
          });
      },
    },
  };
}
