import { z } from 'zod';

// Strong password policy (matches easy-Reader): 8+ chars with upper, lower, digit, special.
export const strongPassword = z
  .string()
  .min(8, '密码至少8位')
  .regex(/[A-Z]/, '密码必须包含至少一个大写字母')
  .regex(/[a-z]/, '密码必须包含至少一个小写字母')
  .regex(/[0-9]/, '密码必须包含至少一个数字')
  .regex(/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/, '密码必须包含至少一个特殊字符');
