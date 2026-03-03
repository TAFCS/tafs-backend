import type {
  BaseApiResponse,
  PaginatedApiResponse,
  PaginatedData,
  PaginationMeta,
} from '../constants/api-response/base-response.constant';

export function createApiResponse<T>(
  data: T,
  status: number,
  message: string,
): BaseApiResponse<T> {
  return { data, status, message };
}

export function createPaginationMeta(
  page: number,
  limit: number,
  total: number,
): PaginationMeta {
  const pages = Math.ceil(total / limit) || 1;

  return {
    page,
    limit,
    total,
    pages,
    hasNext: page < pages,
    hasPrev: page > 1,
  };
}

export function createPaginatedData<T>(
  items: T[],
  meta: PaginationMeta,
): PaginatedData<T> {
  return { items, pagination: meta };
}

export function createPaginatedApiResponse<T>(
  items: T[],
  meta: PaginationMeta,
  status: number,
  message: string,
): PaginatedApiResponse<T> {
  const data = createPaginatedData(items, meta);
  return { data, status, message };
}

