/* jshint esnext:true */
/*
TODO:
- automatically find relevant source layer names by examining .sources {}
✓ iterate through each (possibly nested) filter of each layer, looking for keys that match
- handle OpenMapTiles "park" layer which is used unfiltered, but must be filtered in say mapzen landuse class=park
-- need to define it as park:* on the openmaptiles end
-- detect that, generate a filter that wasn't there previously.
- handle one layer (eg, OMT "motorway" which maps to motorway, motorway_link)
- Some fields have text-substitution in them, like icon-image: "default_{ref_length}"


General issues:
- Mapbox has #rail_station_label to use
- Mapbox uses integer admin_levels (4) not strings ("4")
- Mutually exclusive filters can be generated, should be resolved. Eg, mapbox, class=motorway, class=link
- Mapzen combines all water types which is really hard to deal with.
-- maybe we should add extra $type=polygon anytime there's a fill layer type.
*/




const schemaNames = { mapbox: 0, mapzen: 1, openmaptiles: 2 };

// in theory each can match as a regex, but we can only really handle '.*'
const crosswalk = [
    ['road:structure=tunnel', 'roads:is_tunnel=true', 'transportation:brunnel=tunnel'],
    ['road:structure=bridge', 'roads:is_bridge=true', 'transportation:brunnel=bridge'],
    //['road:class=motorway','roads:kind_detail=motorway','transportation:class=motorway'],
    ['road:class=link','roads:is_link=true','transportation:ramp=1'],
    ['road:class=major_rail','roads:kind_detail=rail','transportation:class=rail'],
    ['road:class=minor_rail','roads:kind_detail=tram','transportation:class=transit'], // eek

    ['road:class=street','roads:kind=minor_road','transportation:class=minor'],
    ['road:class=path','roads:kind=path','transportation:class=path'],
    ['road:class=.*','roads:kind_detail=.*','transportation:class=.*'],
    
    ['road_label:class=street','roads:kind=minor_road','transportation_name:class=minor'],
    ['road_label:class=path','roads:kind=path','transportation_name:class=path'],
    ['road_label:class=.*', 'roads:kind_detail=.*', 'transportation_name:class=.*'], // going from mapzen will be hard
    ['landuse:class=residential','landuse:kind=residential','landuse:class=residential'],
    ['landuse:class=glacier','landuse:kind=glacier','landcover:subclass=glacier'], // not documented, but in Kbasic style
    ['landuse:class=glacier','landuse:kind=glacier','landcover:subclass=ice_shelf'], // not documented, but in Kbasic style
    ['landuse:class=park','Xlanduse:kind=nature_reserve', 'park:class=nature_reserve'],
    ['landuse:class=.*','landuse:kind=.*','landuse:class=.*'],
    ['landuse:class=.*','landuse:kind=.*','landcover:class=.*'],
    // won't work until we solve types
    ['building:height=.*','buildings:height=.*','building:render_height=.*'],
    ['building:_=.*','buildings:_=.*', 'building:_=.*'],
    ['aeroway:type=runway', 'road:kind_detail=runway', 'aeroway:class=runway'],
    ['aeroway:type=taxiway', 'road:kind_detail=taxiway', 'aeroway:class=taxiway'],
    ['place_label:type=suburb','places:kind=neighbourhood', 'place:class=suburb'],
    ['place_label:type=.*','places:kind_detail=.*', 'place:class=.*'],
    ['poi_label:type=.*', 'pois:kind_detail=.*', 'poi:class=.*'],
    // mapbox doesn't seem to have suburb boundaries?
    // also mapbox boundaries don't work cause admin levels have to be integers not strings
    ['admin:admin_level=.*', 'boundaries:kind_detail=.*', 'boundary:admin_level=.*'],
    // untested
    ['admin:maritime=1', 'boundaries:maritime_boundary=true', 'boundary:maritime=1'],
    ['water:_=.*', 'water:$type=Polygon','water:class=*'],
    ['waterway:class=.*', 'water:kind=.*', 'waterway:class=.*'], // mapzen will cause problems with water bodies
    ['water:_=.*', 'water:kind=.*','water:class=.*'] // mapbox water doesn't have classes. TODO

];

function walk(from, to, layerName, key, value) {
    let fromIdx = schemaNames[from], toIdx = schemaNames[to];
    // 
    let mapping;
    if (key) {
        mapping = crosswalk.find(x => (new RegExp(x[fromIdx])).test(`${layerName}:${key}=${value}`));
    } else {
        // no key/value to filter on? Just grab the first layer that matches at all.
        mapping = crosswalk.find(x => {
            return x[fromIdx].replace(/:.*$/, '') === layerName.replace(/:.*$/, '');
        });

    }
    if (!mapping) {
        //console.log('NA ' + `${layerName}:${key}=${value}`);
        return undefined;
    }

    let m = mapping[toIdx].split(/[:=]/);
    if (m[2].match(/\*/)) {
        if (value) {
            m[2] = m[2].replace('.*', value);
        } else {
            // we landed on a wildcard replacementbut we have nothing to replace it with
            console.log('eep ',m);
            return [m[0]];
        }
    }
    //console.log('    ' + m);
    return m;
}

function targetLayer(from, to, sourceLayer, filter) {
    //if (sourceLayer === 'road_label')
    //console.log('!!!',[from,to,sourceLayer,filter]);
    if (filter) {
        if (filter[0] === 'all')
            return filter.slice(1).reduce(((l, f) => l || targetLayer(from, to, sourceLayer, f)), undefined);
        // this is a bit lazy on 'in', might fail if the first 'in' value is unrecognised
        if(filter[0].match(/^(==|!=|in|!in)$/) && filter[1] !== '$type') {
            let tw = walk(from, to, sourceLayer, filter[1], filter[2]);
            return tw && tw[0];
        }
    }
    // no filter, or one we can't handle? take a bigger guess
    let tw = walk(from, to, sourceLayer);
    return tw && tw[0];
    //return undefined;

}

function mapFilter(from, to, sourceLayer, filter) {
    // all -> map individual components
    // == $type -> leave unchanged
    // in -> map each element
    //console.log('    ' + filter);


    if (filter === undefined) {
        // here the source layer had no filter but we think the target should have one.
        let w = walk(from, to, sourceLayer);
        if (w && w.length == 3)
            return ['==', w[1], w[2]];
        else {
            console.log('No filter for ', sourceLayer, ' -> ', w);
            return undefined;
        }
        //return walk(from, to, sourceLayer);
    }
        //return filter;
    if (filter[0] === 'all') {
        if (filter.length === 1)
            console.log([from,to,sourceLayer,filter]);

        return ['all', ...filter.slice(1)
                            .map(f => mapFilter(from, to, sourceLayer, f))
                            .filter(f => f !== undefined) // if a filter doesn't map to anything, just remove it
                ];
    }
    if (filter[0] === 'in') {
        //console.log('YERP' + JSON.stringify(filter.slice(2)));
        // play it safe by converting 'in' to lots if independent matches, in case the key isn't the same
        return ['any', ...filter.slice(2)
                        .map(value => mapFilter(from, to, sourceLayer, ['==', filter[1], value]))
                        .filter(f => f !== undefined)
                ];
    }
    if (filter[0] === '!in') {
        return ['all', ...filter.slice(2)
                        .map(value => mapFilter(from, to, sourceLayer, ['!=', filter[1], value]))
                        .filter(f => f !== undefined)
                ];
    }
    if (filter[0] === '==' || filter[0] === '!=') {
        if (filter[1] === '$type')
            return filter;
        let w = walk(from, to, sourceLayer, filter[1], filter[2]);
        if (!w)
            return undefined;
        //console.log('    ->' + [filter[0], w[1], w[2]]);
        return [filter[0], w[1], w[2]];

    } else {
        return undefined;
    }
}

//let outLayers = [];
function mapLayers(fromSchema, toSchema, layers) {
    let outLayers = [];
    layers.forEach(l => {
        if (typeof l.filter === 'object' && l.filter.length < 3) {
            // defective filter in some liberty layers
            l.filter = undefined;
        }

        if (l.source === undefined) { // background layer
            
            return outLayers.push(l);
        } else if (l.source !== fromSchema) {
            console.warn('Skipping layer with source ' + l.source);
            return
        }
            //console.log(`${l['source-layer']}:${l.filter[1]}=${l.filter[2]}`);

        let tl = targetLayer(fromSchema, toSchema, l['source-layer'], l.filter);
        if (!tl) {
            //console.log('.');
            console.log(`${l['source-layer']}:${JSON.stringify(l.filter)}`);
            return;
        }
        // undefined l.filter is ok
        let tf = mapFilter(fromSchema, toSchema, l['source-layer'], l.filter);
        //console.log(`--> ${tl}:${tf[1]}=${tf[2]}`);
        //console.log(`--> ${tl}:${JSON.stringify(tf)}`);
        

        let outLayer = JSON.parse(JSON.stringify(l));
        outLayer.source = toSchema; // ! conflating our name with internal source name
        outLayer['source-layer'] = tl;
        outLayer.filter = tf;
        outLayers.push(outLayer);
        /*
        if (l.filter !== undefined && l.filter[0] === '==')
            console.log(`${l['source-layer']}:${l.filter[1]}=${l.filter[2]}`);
        else
            console.log(l['source-layer'], JSON.stringify(l.filter));
        */

    });
    return outLayers;
}

const sourceDefs = {    
    mapzen: {
      "type": "vector",
      "tiles": [
        //"https://vector.mapzen.com/osm/all/{z}/{x}/{y}.mvt?api_key=vector-tiles-LM25tq4"
        'http://tile.mapzen.com/mapzen/vector/v1/all/{z}/{x}/{y}.mvt?api_key=vector-tiles-LM25tq4'
      ]
    }, mapbox: {
      url: 'mapbox://mapbox.mapbox-streets-v7',
      type: 'vector'
    }
};

function processStyle(fromSchema, toSchema, style, name='out') {
    let output = JSON.parse(JSON.stringify(style));
    output.layers = mapLayers(fromSchema, toSchema, style.layers);
    output.sources = {
        [toSchema]: sourceDefs[toSchema]
    };
    require('fs').writeFileSync(`./out/${name}-${toSchema}.json`, JSON.stringify(output, undefined, 4));

}

let sourceName = 'osmbright';// = require('./in/kbasic.json')
processStyle('openmaptiles', 'mapbox', require(`./in/${sourceName}.json`), sourceName);
console.log('\n');
processStyle('openmaptiles', 'mapzen', require(`./in/${sourceName}.json`), sourceName);
