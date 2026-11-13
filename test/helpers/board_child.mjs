/**
 * board_child.mjs — 在**独立子进程**里起一块真板服务，只用于测试。
 *
 * 为什么必须独立进程（这是本测试有效性的前提，不是洁癖）：
 *   `remote.js` 上报的 `leaseIdentity` 是**调用方进程**的身份。如果板服务和测试客户端
 *   跑在同一个进程里，两边 pid 必然相同 —— 那么"板服务把调用方的 pid 记下来"和
 *   "板服务把自己 pid 记下来"这两种实现会得到**完全相同**的断言结果，测试就无法区分
 *   方向写反了没有。独立进程让两者 pid 天然不同，方向错了一眼就能看出来。
 *
 * 端口用 0 让系统挑，再把真实端口打到 stdout（`{"port":N}` 一行），
 * 避免"先探测空闲端口再 bind"那套会偶发撞车的写法。
 */
import { startBoardService } from '../../src/server.js';

const svc = await startBoardService({
  boardPath: process.env.DSH_TEAM_BOARD_DB,
  host: '127.0.0.1',
  port: 0,
  token: process.env.DSH_TEAM_BOARD_TOKEN,
  readToken: process.env.DSH_TEAM_BOARD_READ_TOKEN,
  sweep: false, // 测试里不要定时器：避免与断言的时序互相干扰
  logger: { warn: () => {}, info: () => {} },
});

// 唯一给父进程的信号：就绪 + 端口。父进程读到这行才开始发请求。
process.stdout.write(JSON.stringify({ port: svc.port, pid: process.pid }) + '\n');

const shutdown = async () => {
  try {
    await svc.close();
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// 父进程若异常退出，stdin 关闭即自杀，避免留下孤儿板服务
process.stdin.on('end', shutdown);
process.stdin.resume();
