const http = require('http')

const server = http.createServer((req, res) => {
  const body = JSON.stringify({ status: 'ok', path: req.url, method: req.method })
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(body)
})

server.listen(3000, () => {
  console.log('mock-service listening on port 3000')
})
