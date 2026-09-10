export type ErrorCode =
  | 'AuthenticationError' | 'ProviderUnavailableError' | 'RateLimitError'
  | 'ContextLimitError' | 'InvalidToolCallError' | 'ToolExecutionError'
  | 'PermissionDeniedError' | 'WorkspaceViolationError' | 'TimeoutError'
  | 'CancelledError' | 'ConfigurationError' | 'LimitError';

export class MarsError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
    this.name = code;
  }
}
