const ltgt = require('ltgt')

module.exports = function getRange(q, opts) {
  opts = opts || {}
  const lb = ltgt.lowerBound(opts)
  const ub = ltgt.upperBound(opts)
  return Object.assign(
    lb ? (ltgt.lowerBoundExclusive(opts) ?
      {gt: [...q, lb]} :
      {gte: [...q, lb]} 
    ) : {gte: [...q]},
    ub ? (ltgt.upperBoundExclusive(opts) ?
      {lt: [...q, ub]} :
      {lte: [...q, ub]}
    ) : {lt: [...q, undefined]}
  )
}

