const pull = require('pull-stream')
const multicb = require('multicb')
const {test, msg, rndKey} = require('./test-helper')
const Obv = require('obv')

function fooMsg(key, revRoot, revBranch, foo) {
  const ret = msg(key, revRoot, revBranch)
  ret.value.content.foo = foo
  console.log(ret)
  return ret
}

test('use() registers a view', (t, db) => {
  
  function createView(log, name) {
    console.log('creating view')
    const since = Obv()
    let myValue
    since.set(-1)
    return {
      since,
      methods: {
        'foo': 'async'
      },
      createSink: cb => {
        console.log('creating sink')
        return pull(
          pull.asyncMap( (x, cb) => {
            console.log('Got foo:', JSON.stringify(x, null, 2))
            setTimeout( ()=> cb(null, x), 1000)
          }),
          pull.drain( kvv => {
            console.log('Indexing foo:', JSON.stringify(kvv, null, 2))
            if (kvv.value && kvv.value.value && kvv.value.value.content) {
              myValue = kvv.value.value.content.foo
            }
            if (kvv.since) since.set(kvv.since)
          }, (err)=>{
            console.log(err)
            cb(err)
          })
        )
      },
      foo: cb => {
        cb(null, myValue)  
      }
    }
  }

  const sv = db.revisions.use('a_view', createView)
  
  const keyA = rndKey()
  const keyA1 = rndKey()

  db.append([
    fooMsg(keyA, null, [], 'bar1'),
    fooMsg(keyA1, keyA, [keyA], 'bar2')
  ], (err, seq) => {
    console.log('Waiting for', seq)
    sv.foo( (err, data) => {
      t.equal(sv.since.value, seq, 'Should have waited until view is uo-to-date')
      t.equal(data, 'bar2', 'view should have correct value')
      t.end()
    })
  })
})

