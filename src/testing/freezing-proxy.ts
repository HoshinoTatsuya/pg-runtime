import { createServer, type Server, Socket } from 'node:net';

/**
 * TCP-прокси, который умеет «замёрзнуть»: сокеты открыты, байты не идут ни в
 * одну сторону — как сеть, молча роняющая пакеты (security group, чёрная дыра
 * маршрута, зависший балансировщик). Запрос через замёрзший прокси не получает
 * ни ответа, ни отказа.
 */
export const startFreezingProxy = async (target: {
  host: string;
  port: number;
}): Promise<{ port: number; freeze(): void; thaw(): void; close(): Promise<void> }> => {
  const sockets = new Set<Socket>();
  // Байты, пришедшие во время заморозки: не отправлены, уйдут после оттаивания.
  const held: Array<{ to: Socket; chunk: Buffer }> = [];
  let frozen = false;
  const forward = (from: Socket, to: Socket): void => {
    from.on('data', (chunk: Buffer) => {
      if (frozen) {
        held.push({ to, chunk });
      } else {
        to.write(chunk);
      }
    });
    from.on('close', () => to.destroy());
  };
  const server: Server = createServer((inbound) => {
    const outbound = new Socket();
    outbound.connect(target.port, target.host);
    for (const socket of [inbound, outbound]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
    }
    forward(inbound, outbound);
    forward(outbound, inbound);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('прокси без порта');
  }
  return {
    port: address.port,
    freeze: () => {
      frozen = true;
    },
    thaw: () => {
      frozen = false;
      for (const { to, chunk } of held.splice(0)) {
        to.write(chunk);
      }
    },
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
