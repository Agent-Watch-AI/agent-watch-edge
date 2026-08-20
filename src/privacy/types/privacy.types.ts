/** One credential shape recognized in outgoing text. */
export interface SecretPattern {
  /** Diagnostic name; never emitted. */
  readonly name: string;
  /** Global pattern, applied with String.prototype.replace. */
  readonly pattern: RegExp;
  /**
   * Replacement template. Omit to blank the whole match; supply one to keep
   * the harmless part (the scheme, the key name) so the redaction stays
   * readable to whoever is debugging.
   */
  readonly replacement?: string;
}
