const pull = require('pull-stream')
const defer = require('pull-defer')
const next = require('pull-next')
const CreateView = require('flumeview-level')
const ssbsort = require('ssb-sort')
const ltgt = require('ltgt')
const multicb = require('multicb')
const debug = require('debug')('ssb-revisions')

const getRange = require('./get_range')
const Indexing = require('./indexing')
const Stats = require('./indexes/stats')
const Warnings = require('./indexes/warnings')
const Index = require('./indexes/generic')

exports.name = 'revisions'
exports.version = require('./package.json').version
exports.manifest = {
  close: 'async',
  history: 'source',
  heads: 'source',
  updates: 'source',
  stats: 'source',
  warnings: 'source',
  messagesByType: 'source',
  messagesByBranch: 'source'
}

const IDXVER=5

exports.init = function (ssb, config) {
  let _log

  const createView = CreateView(IDXVER, (kv, seq) => {
    const c = kv.value && kv.value.content
    const revisionRoot = c && c.revisionRoot || kv.key
    //console.log('MAP', seq, revisionRoot)
    return [['RS', revisionRoot, seq], ['SR', seq, revisionRoot]]
  })

  const sv = ssb._flumeUse('revisions', (log, name) => {
    _log = log
    return createView(log, name)
  })


  sv.history = function(revRoot, opts) {
    opts = opts || {}
    // lt gt in opts are seqs
    const o = Object.assign(
      getRange(['RS', revRoot], opts), {
        values: true,
        keys: false,
        seqs: true,
        live: opts.live,
        sync: opts.sync
      }
    )
    return pull(
      sv.read(o),
      pull.map(kvv => {
        if (kvv.sync) return kvv
        if (opts.keys == false) delete kvv.value.key
        if (opts.values == false) delete kvv.value.value
        if (opts.seqs) kvv.value.seq = kvv.seq
        return kvv.value
      }),
      stripSingleKey()
    )
  }

  sv.heads = function(revRoot, opts) {
    opts = opts || {}
    const {live, sync} = opts
    const revisions = []
    let synced = false
    const state = {}
    let meta
    if (opts.meta) {
      meta = state.meta = {}
    }
    const stream = pull(
      sv.history(revRoot, Object.assign(
        {}, opts, {
          values: true,
          keys: true,
          sync: live
        }
      )),
      pull.map( kv => {
        if (kv.sync) {
          synced = true
          return sync ? [state, kv] : [state]
        }
        revisions.push(kv)
        state.heads = heads(revRoot, revisions) 
        if (meta) {
          meta.forked = state.heads.length > 1
          meta.incomplete = incomplete(revisions, revRoot)
        }
        return !live || (live && synced) ? [state] : null
      }),
      pull.filter(),
      pull.flatten(),
      pull.asyncMap( (result, cb) =>{
        pull(
          pull.values(result.heads),
          opts.maxHeads ? pull.take(opts.maxHeads) : pull.through(),
          pull.through( h => {
            if (opts.keys == false) delete h.key
            if (opts.values == false) delete h.value
          }),
          stripSingleKey(),
          pull.collect( (err, heads) => {
            if (opts.keys == false && opts.values == false) {
              delete result.heads
            } else {
              result.heads = heads
            }
            cb(err, result)
          })
        )
      }),
      stripSingleKey(),
      filterRepeated( JSON.stringify )
    )
    if (live) return stream
    const deferred = defer.source()
    let lastState
    pull(
      stream,
      pull.drain( result => { lastState = result }, err => {
        if (err) return deferred.resolve(pull.error(err))
        deferred.resolve(pull.once(lastState))
      })
    )
    return deferred
  }

  sv.updates = function(opts) {
    opts = opts || {}
    const oldSeq = opts.since !== undefined ? opts.since : -1
    const limit = opts.limit || 512 // TODO
    let newSeq = -1
    let i = 0
    return next( ()=> { switch(i++) {
      case 0: 
        //console.log('sv.read', oldSeq, '-', sv.since.value)
        if (oldSeq == sv.since.value) {
          newSeq = oldSeq
          return pull.empty()
        }
        const deferred = defer.source()
        // what revRoots where changed?
        pull(
          sv.read({
            gt: ['SR', oldSeq, undefined],
            lte: ['SR', sv.since.value, undefined],
            values: false,
            keys: true,
            seqs: false
          }),
          pull.through( ([_, seq, __]) => {
            newSeq = Math.max(newSeq, seq)
          }),
          pull.map(([_, __, revRoot]) => revRoot),
          pull.unique(),
          pull.take(limit),
          pull.collect( (err, revRoots) => {
            if (err) return deferred.resolve(pull.error(err))
            if (newSeq == -1 || newSeq == oldSeq) {
              // we have not seen any revisions
              //console.log('empty set, oldSeq=', oldSeq)
              newSeq = oldSeq
              return deferred.resolve(pull.empty())
            }
            debug('processing updates from %d to %d', oldSeq, newSeq)
            deferred.resolve(
              pull(
                pull.values(revRoots),
                pull.asyncMap( (revRoot, cb) => {
                  const done = multicb({pluck: 1})
                  getValueAt(sv, revRoot, oldSeq, done())
                  getValueAt(sv, revRoot, newSeq, done())

                  done( (err, values) => {
                    if (err) return cb(err)
                    cb(null, {
                      key: revRoot,
                      old_value: values[0],
                      value: values[1]
                    })
                  })
                })
              )
            )
          })
        )
        return deferred
      case 1: return pull.once({since: newSeq})
    }})
  }

  sv.indexingSource = function(opts) {
    opts = opts || {}
    // console.log('called indexingSource', opts)
    let lastSince = opts.since
    let synced = false  
    return next( ()=> {
      if (synced) {
        synced = false
        return pull(
          (()=>{
            let ended
            return function read(end, cb) {
              ended = end || ended
              if (ended) return cb(ended)
              if (sv.since.value > lastSince) return cb(true)
              debug('waiting ...')
              // wait for the next time 'since' is set
              sv.since.once( ()=> cb(true), false )
            }
          })()
        )
      }
      //console.log('pulling non-live updates since', lastSince)
      return pull(
        sv.updates({since: lastSince}),
        pull.map( kvv => {
          if (kvv.since !== undefined) {
            debug('received since %d', kvv.since)
            if (kvv.since == lastSince) {
              //console.log('synced!')
              synced = true
              return null
            } else {
              lastSince = kvv.since
            }
          }
          return kvv
        }),
        pull.filter()
      )
    })
  }

  const addView = Indexing(ssb, _log, ssb.ready, sv.indexingSource)
  sv.use = function(name, createView) {
    debug('use %s', name)
    sv[name] = addView(name, createView)

    /*
    ssb._flumeUse(name, (log, name) => {
      console.log('Calling fake createView')
      function ViewProxy() {
        this.createSink = function() {
          console.log('Calling fake createSink')
          return pull.drain()
        }
      }
      ViewProxy.prototype = sv[name].unwrapped
      return new ViewProxy()
    })
    */
    return sv
  }

  const close = sv.close
  sv.close = function(cb) {
    debug('closing dependent views')
    addView.close(()=>{
      if (close) {
        //console.log('calling orig close')
        close(cb) 
      } else cb()
    })
  }

  sv.use('Stats', Stats())
  sv.stats = sv.Stats.unwrapped.stream

  sv.use('Warnings', Warnings())
  sv.warnings = sv.Warnings.unwrapped.read

  sv.use('BranchIndex', Index('branch'))
  sv.messagesByBranch= (name, opts) => sv.BranchIndex.unwrapped.read(Object.assign({
    gt: [name, null],
    lt: [name, undefined]
  }, opts || {}))

  sv.use('TypeIndex', Index('type'))
  sv.messagesByType = (name, opts) => sv.TypeIndex.unwrapped.read(Object.assign({
    gt: [name, null],
    lt: [name, undefined]
  }, opts || {}))

  return sv
}

// utils ///////

function getValueAt(sv, revRoot, at, cb) {
  pull(
    sv.heads(revRoot, {
      lte: at,
      keys: true,
      values: true,
      seqs: true,
      meta: true,
      maxHeads: 1
    }),
    pull.collect((err, items) => {
      if (err) return cb(err)
      if (!items.length) return cb(null, null)
      cb(null, {
        key: items[0].heads[0].key, 
        value: items[0].heads[0].value, 
        seq: items[0].heads[0].seq, 
        meta: items[0].meta,
      })
    })
  )
}

function stripSingleKey() {
  return pull.map( kv => {
    if (kv.sync) return kv
    if (Object.keys(kv).length == 1) {
      for(let k in kv) return kv[k]
    }
    return kv
  })
}

function filterRepeated(f) {
  let last
  return pull.filter( x => {
    const y = f(x)
    const ret = last != y
    last = y
    return ret
  })
}

function ary(x) {
  if (x==undefined || x==null) return []
  return Array.isArray(x) ? x : [x]
}

function incomplete(msgs, revRoot) {
  const revs = msgs.reduce( (acc, kv) => (acc[kv.key] = kv, acc), {})
  for(let m of msgs) {
    for(let b of ary(m.value.content.revisionBranch)) {
      if (!revs[b]) return true
    }
  }
  return false
}

function heads(revisionRoot, revisions) {
  const strippedRevs = revisions.map( kv => {
    const {revisionRoot, revisionBranch} = kv.value.content
    return {
      key: kv.key,
      value: {
        timestamp: kv.value.timestamp,
        content: {
          revisionRoot,
          revisionBranch
        }
      }
    }
  })

  const hds = ssbsort.heads(strippedRevs)
  const revs = revisions.reduce( (acc, kv) => (acc[kv.key] = kv, acc), {})
  return hds.map( k => revs[k] ).sort(compare)
}

function compare(a, b) {
  return (
    //declared timestamp, may by incorrect or a lie
    (b.value.timestamp - a.value.timestamp) ||
    //finially, sort hashes lexiegraphically.
    (a.key > b.key ? -1 : a.key < b.key ? 1 : 0)
  )
}

function toMsg(revisionRoot) {
  return function(r) {
    const {key, revisionBranch, timestamp} = r
    return {
      key,
      value: {
        timestamp,
        content: {revisionRoot, revisionBranch}
      }
    }
  }
}

function isUpdate(kv) {
  const content = kv.value && kv.value.content
  if (!content) return false
  const revRoot = content.revisionRoot
  const revBranch = content.revisionBranch
  if (!revRoot || !revBranch) return false
  if (revRoot == kv.key) return false
  return true
}
