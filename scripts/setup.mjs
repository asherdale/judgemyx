import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const PREFIX = process.env.PROFILE_PREFIX || 'judgemyx'
const [, provider, model] = readFileSync('agents/judge.yaml', 'utf8').match(/model:\s*\n\s+provider_config:\s*(\S+)\s*\n\s+name:\s*(\S+)/)
const omnara = (...args) => JSON.parse(execFileSync('npx', ['-y', 'omnara', ...args, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }))
const list = (r) => r.data ?? r

const granted = list(omnara('grant', 'models', 'list')).some((g) => g.model.provider_config === provider && g.model.name === model)
if (!granted) throw new Error(`${provider}/${model} isn't granted to this project. Grant it, or change model in agents/judge.yaml.`)
const name = `${PREFIX}-judge`, existing = list(omnara('profiles', 'list', '--name', name))[0]
const profile = existing ? omnara('profiles', 'update', existing.id, '--file', 'agents/judge.yaml') : omnara('profiles', 'create', '--name', name, '--file', 'agents/judge.yaml')
writeFileSync('agents/profiles.txt', `judge ${existing?.id ?? profile.id}\n`)
console.log(`${existing ? 'updated' : 'created'} ${name} (${model}) and wrote agents/profiles.txt`)
