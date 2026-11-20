import { randomUUID } from 'node:crypto';
import { logger } from '../../lib/logger.js';

type GoogleApiResponse<T> = {
  data: T;
  status?: number;
};

function getErrorMetadata(error: unknown) {
  if (typeof error !== 'object' || error === null) {
    return {};
  }

  const properties = error as {
    code?: unknown;
    response?: { status?: unknown } | null;
  };
  const statusCode = properties.response?.status;
  return {
    ...(typeof statusCode === 'number' ? { statusCode } : {}),
    ...(typeof properties.code === 'string' ? { code: properties.code } : {}),
  };
}

export async function logGoogleApiRequest<T>(input: {
  service: 'calendar' | 'gmail';
  operation: string;
  userId?: string;
  calendarId?: string;
  request: () => Promise<GoogleApiResponse<T>>;
  getResultCount?: (data: T) => number;
}): Promise<GoogleApiResponse<T>> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const logContext = {
    requestId,
    service: input.service,
    operation: input.operation,
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.calendarId ? { calendarId: input.calendarId } : {}),
  };

  logger.info(logContext, 'Google API request started');
  try {
    const response = await input.request();
    logger.info(
      {
        ...logContext,
        statusCode: response.status,
        durationMs: Date.now() - startedAt,
        ...(input.getResultCount
          ? { resultCount: input.getResultCount(response.data) }
          : {}),
      },
      'Google API request completed',
    );
    return response;
  } catch (error) {
    logger.error(
      {
        ...logContext,
        ...getErrorMetadata(error),
        durationMs: Date.now() - startedAt,
      },
      'Google API request failed',
    );
    throw error;
  }
}
