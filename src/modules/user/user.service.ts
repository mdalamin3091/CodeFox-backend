import prisma from '../../config/prisma';
import ApiError from '../../utils/ApiError';
import { UpdateProfileInput } from './user.schema';

export const getProfile = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, emailVerified: true, image: true, createdAt: true, updatedAt: true },
  });

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  return user;
};

export const updateProfile = async (userId: string, input: UpdateProfileInput) => {
  const user = await prisma.user.update({
    where: { id: userId },
    data: input,
    select: { id: true, name: true, email: true, emailVerified: true, image: true, createdAt: true, updatedAt: true },
  });

  return user;
};
