import express from 'express'
import cors from 'cors'
import crypto from 'crypto'

const app = express()
app.disable('x-powered-by')
app.use(cors({
  origin: (process.env.PANEL_ORIGINS || '').split(',').map(x=>x.trim()).filter(Boolean),
  credentials: false
}))
app.use('/producer', express.raw({type:'image/jpeg', limit:'2mb'}))
app.use(express.json({limit:'64kb'}))

const PORT = Number(process.env.PORT || 8787)
const PRODUCER_TOKEN = process.env.PRODUCER_TOKEN || ''
const VIEWER_TOKEN = process.env.VIEWER_TOKEN || ''
const cameras = new Map()
const demand = new Map()

const CAMERA_NAMES = {
  'camera-teste-01': ['Câmera 01','Bancada / Teste'],
  'onibus-01-camera-02': ['Câmera 02','Ônibus 01'],
  'onibus-01-camera-03': ['Câmera 03','Ônibus 01']
}

function safeEqual(a,b){
  const A=Buffer.from(String(a||'')), B=Buffer.from(String(b||''))
  return A.length===B.length && A.length>0 && crypto.timingSafeEqual(A,B)
}
function producer(req,res,next){
  if(!PRODUCER_TOKEN) return res.status(503).json({error:'PRODUCER_TOKEN não configurado'})
  if(!safeEqual(req.get('x-producer-token'),PRODUCER_TOKEN)) return res.status(401).json({error:'não autorizado'})
  next()
}
function viewer(req,res,next){
  if(!VIEWER_TOKEN) return next() // piloto: leitura pública somente se VIEWER_TOKEN não foi definido
  if(!safeEqual(req.get('x-viewer-token')||req.query.token,VIEWER_TOKEN)) return res.status(401).json({error:'não autorizado'})
  next()
}
function row(id){
  if(!cameras.has(id)) cameras.set(id,{id,lastSeen:0,lastFrameAt:0,frame:null,connected:false,sd:null})
  return cameras.get(id)
}
function status(id){
  const c=row(id), meta=CAMERA_NAMES[id]||[id,'']
  const online=Date.now()-c.lastSeen<20000
  return {
    id, name:meta[0], group:meta[1], online,
    p2p_connected: !!c.connected,
    last_seen:c.lastSeen?new Date(c.lastSeen).toISOString():null,
    last_frame_at:c.lastFrameAt?new Date(c.lastFrameAt).toISOString():null,
    sd:c.sd||null,
    snapshot_url:c.frame?`/api/cameras/${id}/snapshot`:null,
    live_url:online?`/api/cameras/${id}/live.mjpg`:null,
    live_type:'mjpeg'
  }
}

app.get('/health',(_req,res)=>res.json({ok:true,service:'ScreenCity Camera Gateway',time:new Date().toISOString()}))

app.post('/producer/heartbeat/:id', producer, (req,res)=>{
  const id=req.params.id
  if(!CAMERA_NAMES[id]) return res.status(404).json({error:'câmera desconhecida'})
  const c=row(id); c.lastSeen=Date.now()
  c.connected=!!req.body?.connected
  if(req.body?.sd) c.sd=req.body.sd
  res.json({ok:true,demandUntil:demand.get(id)||0})
})

app.get('/producer/command', producer, (_req,res)=>{
  const now=Date.now()
  const requested=Object.entries(CAMERA_NAMES)
    .map(([id])=>({id,until:demand.get(id)||0}))
    .filter(x=>x.until>now)
    .sort((a,b)=>b.until-a.until)[0] || null
  res.json({camera_id:requested?.id||null,live_requested:!!requested})
})

app.post('/producer/frame/:id', producer, (req,res)=>{
  const id=req.params.id
  if(!CAMERA_NAMES[id]) return res.status(404).end()
  if(!Buffer.isBuffer(req.body)||req.body.length<100) return res.status(400).end()
  const c=row(id)
  c.frame=Buffer.from(req.body); c.lastFrameAt=Date.now(); c.lastSeen=Date.now(); c.connected=true
  res.status(204).end()
})

app.get('/api/cameras/status', viewer, (_req,res)=>{
  res.json({cameras:Object.keys(CAMERA_NAMES).map(status)})
})

app.post('/api/cameras/:id/request-live', viewer, (req,res)=>{
  const id=req.params.id
  if(!CAMERA_NAMES[id]) return res.status(404).json({error:'câmera desconhecida'})
  demand.set(id,Date.now()+45000)
  res.json({ok:true,camera:status(id),demand_until:new Date(demand.get(id)).toISOString()})
})

app.post('/api/cameras/:id/stop-live', viewer, (req,res)=>{
  demand.delete(req.params.id); res.json({ok:true})
})

app.get('/api/cameras/:id/snapshot', viewer, (req,res)=>{
  const c=row(req.params.id)
  if(!c.frame) return res.status(404).end()
  res.set({'Content-Type':'image/jpeg','Cache-Control':'no-store'})
  res.end(c.frame)
})

app.get('/api/cameras/:id/live.mjpg', viewer, (req,res)=>{
  const id=req.params.id
  if(!CAMERA_NAMES[id]) return res.status(404).end()
  demand.set(id,Date.now()+45000)
  res.writeHead(200,{
    'Content-Type':'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control':'no-store, no-cache, must-revalidate',
    'Connection':'keep-alive'
  })
  let last=0
  const timer=setInterval(()=>{
    demand.set(id,Date.now()+15000)
    const c=row(id)
    if(!c.frame || c.lastFrameAt===last) return
    last=c.lastFrameAt
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${c.frame.length}\r\n\r\n`)
    res.write(c.frame); res.write('\r\n')
  },250)
  req.on('close',()=>{clearInterval(timer); demand.delete(id)})
})

app.listen(PORT,()=>console.log(`ScreenCity Camera Gateway na porta ${PORT}`))
