interface RetryOptions {
  maxAttempts?: number
  initialDelay?: number
  maxDelay?: number
}

/**
 * Retries an async operation with exponential backoff
 * @param operation - The async operation to retry
 * @param options - Configuration options for retry behavior
 * @returns Promise resolving to the operation result
 */
export async function retryWithExponentialBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3
  const initialDelay = options.initialDelay ?? 1000
  const maxDelay = options.maxDelay ?? 10000

  let attempt = 1
  let delay = initialDelay

  while (true) {
    try {
      return await operation()
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error
      }

      // Only retry on specific errors that might be temporary
      if (
        error instanceof Error &&
        !error.message.includes('rate limit') &&
        !error.message.includes('timeout') &&
        !error.message.includes('network') &&
        !error.message.includes('5') // 5xx errors
      ) {
        throw error
      }

      const jitter = Math.random() * 200 // Add some randomness to prevent thundering herd
      delay = Math.min(delay * 2, maxDelay) + jitter

      console.warn(`Attempt ${attempt} failed, retrying in ${delay}ms...`)
      await new Promise((resolve) => setTimeout(resolve, delay))
      attempt++
    }
  }
}
