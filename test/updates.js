const pull = require('pull-stream')
const multicb = require('multicb')
const {test, msg, rndKey} = require('./test-helper')

function append(db, msgs, cb) {
  pull(
    pull.values(msgs),
    pull.asyncMap( (m, cb) => {
      db.append(m, cb)
    }),
    pull.collect( (err, seqs)=>{
      if (err) throw err
      cb(seqs)
    })
  )
}

test('updates (single)', (t, db) => {
  const keyA = rndKey()
  const a = msg(keyA)

  append(db, [a], seqs => {
    db.revisions.since( since => {
      console.log('sv is at ', since)
      if (since< seqs.slice(-1)[0]) return
      pull(
        db.revisions.updates(),
        pull.collect( (err, items) => {
          t.notOk(err, 'no error')
          console.log('items', items)
          t.equal(items.length, 2)
          t.deepEquals(items[0], {
            key: keyA,
            value: {
              key: a.key,
              value: a.value,
              seq: seqs[0],
              meta: {
                forked: false,
                incomplete: false
              },
            },
            old_value: null,
          })
          t.deepEquals(items[1], {
            since: seqs[0]
          })
          t.end()
        })
      )
    })
  })
})

test('updates {since: 0}', (t, db) => {
  const keyA = rndKey()
  const keyB = rndKey()
  const a = msg(keyA)
  const b = msg(keyB)

  append(db, [a, b], seqs => {
    db.revisions.since( since => {
      console.log('sv is at ', since)
      if (since< seqs.slice(-1)[0]) return
      pull(
        db.revisions.updates({since: seqs[0]}),
        pull.collect( (err, items) => {
          t.notOk(err, 'no error')
          console.log('items', items)
          t.equal(items.length, 2)
          t.deepEquals(items[0], {
            key: keyB,
            value: {
              key: b.key,
              value: b.value,
              seq: seqs[1],
              meta: {forked: false, incomplete: false},
            },
            old_value: null
          })
          t.deepEquals(items[1], {
            since: seqs[1]
          })
          t.end()
        })
      )
    })
  })
})

test('updates (old value)', (t, db) => {
  const keyA = rndKey()
  const keyB = rndKey()
  const a = msg(keyA)
  const b = msg(keyB, keyA, [keyA])

  append(db, [a, b], seqs => {
    db.revisions.since( since => {
      console.log('sv is at ', since)
      if (since< seqs.slice(-1)[0]) return
      pull(
        db.revisions.updates({since: seqs[0]}),
        pull.collect( (err, items) => {
          t.notOk(err, 'no error')
          console.log('items', items)
          t.equal(items.length, 2)
          t.deepEquals(items[0], {
            key: keyA,
            value: {
              key: b.key,
              value: b.value,
              seq: seqs[1],
              meta: {forked: false, incomplete: false},
            },
            old_value: {
              key: a.key,
              value: a.value,
              seq: seqs[0],
              meta: {forked: false, incomplete: false},
            }
          })
          t.deepEquals(items[1], {
            since: seqs[1]
          })
          t.end()
        })
      )
    })
  })
})

test('updates (meta)', (t, db) => {
  const keyA = rndKey()
  const keyB = rndKey()
  const keyC = rndKey()
  const keyD = rndKey()
  const a = msg(keyA)
  const b = msg(keyB, keyA, [keyA])
  const c = msg(keyC, keyA, [keyA]) // fork
  const d = msg(keyD, keyA, [keyB, keyC]) // merge

  append(db, [a, b, c, d], seqs => {
    db.revisions.since( since => {
      console.log('sv is at ', since)
      if (since< seqs.slice(-1)[0]) return
      pull(
        db.revisions.updates({since: seqs[2]}),
        pull.collect( (err, items) => {
          t.notOk(err, 'no error')
          console.log('items', items)
          t.equal(items.length, 2)
          t.deepEquals(items[0], {
            key: keyA,
            value: {
              key: d.key,
              value: d.value,
              seq: seqs[3],
              meta: {forked: false, incomplete: false},
            },
            old_value: {
              key: c.key,
              value: c.value,
              seq: seqs[2],
              meta: {forked: true, incomplete: false},
            }
          })
          t.deepEquals(items[1], {
            since: seqs[3]
          })
          t.end()
        })
      )
    })
  })
})


