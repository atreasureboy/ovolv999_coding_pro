const required = ['OPENAI_API_KEY', 'OVOGO_REAL_EVAL_MODEL']
const missing = required.filter((name) => !process.env[name]?.trim())
if (process.env.OVOGO_REAL_EVAL !== '1') missing.unshift('OVOGO_REAL_EVAL=1')
if (missing.length) {
  process.stderr.write(`Real eval is not configured. Set ${missing.join(', ')}.\n`)
  process.exit(1)
}
