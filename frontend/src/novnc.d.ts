/// <reference types="@types/novnc__novnc" />

// noVNC 1.7 exports the ESM client at the package root. The published 1.6
// declarations still use its former lib/rfb entry point.
declare module '@novnc/novnc' {
  import RFB from '@novnc/novnc/lib/rfb';
  export default RFB;
}
