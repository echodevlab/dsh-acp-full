/** 真实 ACP 客户端 smoke：spawn dsh --profile acp，验证请求与连接关闭行为。 */
import { spawn } from 'node:child_process'

const child = spawn('dsh', ['--profile', 'acp'], { stdio: ['pipe', 'pipe', 'inherit'] })

let output = ''
child.stdout.on('data', chunk => {
  output += chunk.toString()
  console.log('OUT:', chunk.toString().trim())
})

const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n')

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })

setTimeout(() => {
  console.log('--- closing stdin (client disconnect) ---')
  child.stdin.end()
}, 4000)

setTimeout(() => {
  console.log('exitCode after stdin end:', child.exitCode)
  console.log('killedBySignal:', child.signalCode)
  if (child.exitCode === null) {
    console.log('STILL RUNNING after disconnect -> FAIL')
    child.kill()
    process.exit(1)
  }
  console.log('exited cleanly after disconnect -> PASS')
  process.exit(0)
}, 9000)
