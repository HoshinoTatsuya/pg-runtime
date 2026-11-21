/** Обещание с потолком: зависание — отказ с текстом, а не таймаут теста без причины. */
export const withinSeconds = async <T>(seconds: number, work: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`не завершилось за ${seconds} с`)), seconds * 1000);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
};
