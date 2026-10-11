/** A self-supplied native website field, distinct from transport or identity support. */
export interface NativeWebsiteDeclaration {
  platform: 'github' | 'x';
  nativeId: string;
  requestedUrl: string;
  returnedProfileUrl: string;
  payloadField: 'blog' | 'website';
  rawLiteral: string;
  fieldOffset: number;
  sourceContentHash: string;
  protocol: 'https' | 'http' | 'protocol_less' | 'invalid';
  /** Parsed declared namespace only; HTTP/protocol-less values are never fetch permissions. */
  declaredUrl: string | null;
  /** Populated only for a valid actually declared public HTTPS value. */
  publicHttpsUrl: string | null;
}
