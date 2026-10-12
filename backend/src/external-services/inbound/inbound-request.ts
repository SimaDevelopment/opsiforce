export interface InboundUpload {
  field: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface InboundRequest {
  method: string;
  headers: Record<string, string>;
  query: Record<string, string | string[]>;
  rawBody: Uint8Array;
  fields?: Record<string, string>;
  files: InboundUpload[];
  bytes: number;
}
