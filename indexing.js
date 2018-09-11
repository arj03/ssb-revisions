const debug = require('debug')('ssb-revisions indexing')
const wrap = require('flumedb/wrap')
const Looper = require('pull-looper')
const pull = require('pull-stream')
const explain = require('explain-error')

module.exports = function(log, ready, createStream) {
  const views = {}
  const meta = {}

  return function use(name, createView) {

    if(~Object.keys(views).indexOf(name))
      throw new Error(name + ' is already in use!')

    var sv = createView(log, name)

    views[name] = wrap(sv, log.since, ready)
    meta[name] = views[name].meta

    sv.since.once(function build (upto) {
      log.since.once(function (since) {
        if(upto > since) {
          sv.destroy(function () { build(-1) })
        } else {
          var opts = {
            gt: upto,
            live: true,
            seqs: true,
            values: true,
            old_values: true
          }
          
          if (upto == -1) opts.cache = false

          pull(
            createStream(opts),
            Looper,
            sv.createSink(function (err) {
              //if(!flume.closed) {
                if(err)
                  console.error(explain(err, 'view stream error'))
                sv.since.once(build)
              //}
            })
          )
        }
      })
    })

    return views[name]
  }
}