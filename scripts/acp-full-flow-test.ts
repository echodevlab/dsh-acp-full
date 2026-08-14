/**
 * 完整 ACP 会话流 smoke：initialize → session/new → session/prompt（真实模型）→ 流式更新 → 断开。
 * 需要 DSH_HOME settings 中已配置可用的 provider（如 axon + AXON_API_KEY）。
 */
import { spawn } from 'node:child_process'

const child = spawn('dsh', ['--profile', 'acp'], { stdio: ['pipe', 'pipe', 'inherit'] })

let buffer = ''
let nextId = 1
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
const notifications: unknown[] = []

child.stdout.on('data', (chunk: Buffer) => {
  buffer += chunk.toString()
  let newline: number
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    const message = JSON.parse(line) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } }
    if (message.method === 'session/update') {
      notifications.push(message.params)
      const update = (message.params as { update: { sessionUpdate: string } }).update
      console.log(`NOTIFY ${update.sessionUpdate} #${notifications.length}`)
    } else if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id)!
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    }
  }
})

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextId++
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
  const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  console.log('initialize OK:', (initialized as { protocolVersion: number }).protocolVersion)

  const created = await request('session/new', { cwd: process.cwd(), mcpServers: [] })
  const sessionId = (created as { sessionId: string }).sessionId
  console.log('session/new OK:', sessionId)

  const prompt = request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'Reply with exactly: ACP works.' }],
  })

  // 等待流式更新与 prompt 结算（真实模型调用，最长等 120s）
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    await wait(500)
    const entry = pending.get(1)
    if (entry === undefined) break
  }
  // 重新拿 prompt 响应（pending 里 id=3 可能还在则等）
  const promptResult = await Promise.race([
    prompt,
    wait(120_000).then(() => { throw new Error('prompt timeout after 120s') }),
  ])
  console.log('session/prompt OK:', JSON.stringify(promptResult))
  console.log(`streamed ${notifications.length} session/update notifications`)

  const kinds = notifications.map(n => (n as { update: { sessionUpdate: string } }).update.sessionUpdate)
  const hasAgentChunk = kinds.includes('agent_message_chunk')
  const hasUserChunk = kinds.includes('user_message_chunk')
  console.log('agent_message_chunk seen:', hasAgentChunk, '| user_message_chunk seen:', hasUserChunk)

  console.log('--- closing stdin ---')
  child.stdin.end()
  const exited = await new Promise<number | null>(resolve => {
    child.on('exit', code => resolve(code))
    setTimeout(() => resolve(null), 15_000)
  })
  console.log('exit code:', exited)
  if (exited !== 0) {
    child.kill()
    process.exit(1)
  }
  console.log('FULL FLOW PASS')
  process.exit(0)
}

void main().catch(error => {
  console.error('FAIL:', String(error))
  child.kill()
  process.exit(1)
})
