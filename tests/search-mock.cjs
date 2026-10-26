// Instagram's search requests, answered the way the website answers them
// today (bundles fetched 2026-10-21; see notes/batch-3/diagnosis.md, B12/B13):
//  - the old REST search endpoints answer 404 HTML, like a made-up path;
//  - GraphQL answers only a query's current doc_id, and refuses a request
//    that leaves out a setting ("provided variable") the query declares;
//  - the search box query returns accounts only (no tags or places).
// These are fixtures modelled on that evidence, not captures.
'use strict';
const { media, user } = require('./helpers.cjs');

const NOT_FOUND = '<!DOCTYPE html><html lang="en"><head><title>Page Not Found &bull; Instagram</title></head><body>Sorry, this page isn\'t available.</body></html>';
const DEAD_PATHS = ['/web/search/topsearch/', '/api/v1/locations/web_info/', '/api/v1/fbsearch/web/top_serp/'];
// Every request SimpleGram 1.1 made that Instagram no longer answers.
const DEAD_RE = /\/web\/search\/topsearch\/|\/api\/v1\/locations\/web_info\/|\/api\/v1\/locations\/[^/]+\/sections\/|\/api\/v1\/fbsearch\/web\/top_serp\//;

const SD = '__relay_internal__pv__PolarisShortDramaEnabledrelayprovider';
const SEO = '__relay_internal__pv__PolarisSEOIsCrawlerrelayprovider';
const IDS = {
  PolarisSearchBoxRefetchableQuery: '27706427925724183',
  PolarisAPITopsearchQuery: '29386906664232128',
  PolarisKeywordSearchExplorePageRelayQuery: '37324993597144881',
  PolarisKeywordSearchExplorePageRelayPaginationQuery: '28656899673911396',
  PolarisLocationPageTabContentQuery: '28586113187724473',
  PolarisLocationPageTabContentQuery_connection: '29002281179411948',
  PolarisExploreLocationsContainerQuery: '28572807415659320',
};
const PROVIDERS = {
  PolarisLocationPageTabContentQuery: [SD, SEO],
  PolarisLocationPageTabContentQuery_connection: [SD, SEO],
};
const ROOTS = {
  PolarisSearchBoxRefetchableQuery: 'xdt_api__v1__fbsearch__topsearch_connection',
  PolarisAPITopsearchQuery: 'xdt_api__v1__fbsearch__topsearch_connection',
  PolarisKeywordSearchExplorePageRelayQuery: 'xdt_fbsearch__top_serp_graphql',
  PolarisKeywordSearchExplorePageRelayPaginationQuery: 'xdt_fbsearch__top_serp_graphql',
  PolarisLocationPageTabContentQuery: 'xdt_location_get_web_info_tab',
  PolarisLocationPageTabContentQuery_connection: 'xdt_location_get_web_info_tab',
  PolarisExploreLocationsContainerQuery: 'xdt_location_get_web_info',
};

function nodes(list) { return list.map(c => ({ node: media(c, user('u' + c, true)) })); }
function keywordGrid(list, more) {
  return { edges: [{ node: { __typename: 'XDTTopSerpHeaderUnit' } }, { node: { __typename: 'XDTTopSerpMediaGridUnit', items: list.map(c => media(c, user('u' + c, true))) } }],
    page_info: { has_next_page: !!more, end_cursor: more || null } };
}

// Answers for each query: the content of the query's root field, or
// { status, body } for a raw HTTP answer, or null for Instagram's "execution error".
function defaultAnswers(o) {
  return {
    PolarisSearchBoxRefetchableQuery: () => ({ users: (o.users || []).map((u, i) => ({ position: i, user: u })), hashtags: (o.blendedTags || []).map(h => ({ hashtag: h })),
      places: (o.blendedPlaces || []).map(p => ({ place: p })), see_more: { list: [] }, rank_token: 'r' }),
    PolarisAPITopsearchQuery: v => ({ users: [], places: [], hashtags: v.data && v.data.context === 'hashtag' ? (o.tags || []).map((h, i) => ({ position: i, hashtag: h })) : [] }),
    PolarisKeywordSearchExplorePageRelayQuery: () => keywordGrid(o.keyword || [], o.keywordMore),
    PolarisKeywordSearchExplorePageRelayPaginationQuery: () => keywordGrid(o.keywordNext || [], null),
    PolarisLocationPageTabContentQuery: v => ({ edges: nodes(v.tab === 'recent' ? (o.placeRecent || []) : (o.place || [])),
      page_info: { has_next_page: !!o.placeMore, end_cursor: o.placeMore || null } }),
    // The signed-in capture saw this query send back the cursor it was given.
    PolarisLocationPageTabContentQuery_connection: v => ({ edges: nodes(o.placeNext || []), page_info: { has_next_page: true, end_cursor: v.after } }),
    PolarisExploreLocationsContainerQuery: v => ({ native_location_data: { location_info: Object.assign({ location_id: v.location_id_str }, o.placeInfo || {}) } }),
  };
}

/**
 * The GraphQL endpoint. Every request is kept in `log` as
 * { path, name, id, vars, keys, result }.
 */
function graphql(o = {}) {
  const ids = Object.assign({}, IDS, o.ids);
  const providers = Object.assign({}, PROVIDERS, o.providers);
  const answers = Object.assign(defaultAnswers(o), o.answers);
  const log = [];
  function handler(u, req) {
    const form = new URLSearchParams(req.postData() || '');
    const name = form.get('fb_api_req_friendly_name');
    const id = form.get('doc_id');
    let vars = {};
    try { vars = JSON.parse(form.get('variables') || '{}'); } catch (e) { /* bad body */ }
    const entry = { path: u.pathname, name, id, vars, keys: Object.keys(vars) };
    log.push(entry);
    if (o.status) { entry.result = 'http ' + o.status; return { status: o.status, body: '<html>error</html>' }; }
    let body;
    if (ids[name] !== id) {
      body = { errors: [{ message: 'PersistedQueryNotFound', severity: 'CRITICAL', code: 1675002 }], data: null };
    } else {
      const missing = (providers[name] || []).filter(k => !(k in vars));
      if (missing.length) {
        body = { errors: [{ message: o.unnamedMissing ? 'execution error' : 'missing_required_variable_value: ' + missing.join(','), severity: 'CRITICAL', code: 1675030 }], data: null };
      } else {
        const out = answers[name] ? answers[name](vars, entry) : null;
        if (out && out.status) { entry.result = 'http ' + out.status; return out; }
        body = out ? { data: { [ROOTS[name]]: out }, extensions: { is_final: true } } : { errors: [{ message: 'execution error', code: 1675004 }], data: null };
      }
    }
    entry.result = body.errors ? 'error ' + body.errors[0].message : 'data';
    return { body };
  }
  return { handler, log, ids };
}

/** An `api` map for helpers.open(): the dead endpoints, GraphQL, and the given extras. */
function site(o = {}, extra = {}) {
  const gql = graphql(o);
  const api = { '/api/graphql': gql.handler, '/graphql/query': gql.handler };
  for (const p of DEAD_PATHS) api[p] = () => ({ status: 404, body: NOT_FOUND });
  return { api: Object.assign(api, extra), log: gql.log };
}

module.exports = { NOT_FOUND, DEAD_PATHS, DEAD_RE, SD, SEO, IDS, ROOTS, graphql, site, keywordGrid };
