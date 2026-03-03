export interface BaseApiResponse<T> {
  data: T;
  status: number;
  message: string;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  pages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface PaginatedData<T> {
  items: T[];
  pagination: PaginationMeta;
}

export interface PaginatedApiResponse<T> {
  data: PaginatedData<T>;
  status: number;
  message: string;
}

