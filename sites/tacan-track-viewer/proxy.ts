import { NextResponse } from 'next/server';

import { SECURITY_HEADERS } from './lib/security-headers';

export function proxy() {
  const response = NextResponse.next();
  SECURITY_HEADERS.forEach(({ key, value }) => response.headers.set(key, value));
  return response;
}

export const config = { matcher: '/:path*' };
