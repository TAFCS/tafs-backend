import { BadRequestException } from '@nestjs/common';

export const MAX_PAGINATION_TAKE = 100;

export function parsePagination(
  take?: string,
  skip?: string,
  defaultTake = 50,
  maxTake = MAX_PAGINATION_TAKE,
): { take: number; skip: number } {
  const parsedTake = take !== undefined ? parseInt(take, 10) : defaultTake;
  const parsedSkip = skip !== undefined ? parseInt(skip, 10) : 0;
  if (
    Number.isNaN(parsedTake) ||
    Number.isNaN(parsedSkip) ||
    parsedTake < 1 ||
    parsedSkip < 0
  ) {
    throw new BadRequestException('Invalid pagination parameters');
  }
  return { take: Math.min(parsedTake, maxTake), skip: parsedSkip };
}
