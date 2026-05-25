import _ from 'lodash';

export default {

    prefix: '/v1',

    get: {
        '/models': async () => {
            return {
                "data": [
                    {
                        "id": "jimeng-video-seedance-2.0-fast-vip",
                        "object": "model",
                        "owned_by": "jimeng-api",
                        "description": "Seedance 2.0 Fast VIP (默认)"
                    },
                    {
                        "id": "jimeng-video-seedance-2.0-vip",
                        "object": "model",
                        "owned_by": "jimeng-api",
                        "description": "Seedance 2.0 Pro VIP"
                    },
                    {
                        "id": "jimeng-video-seedance-2.0-fast",
                        "object": "model",
                        "owned_by": "jimeng-api",
                        "description": "Seedance 2.0 Fast"
                    },
                    {
                        "id": "jimeng-video-seedance-2.0",
                        "object": "model",
                        "owned_by": "jimeng-api",
                        "description": "Seedance 2.0 Pro"
                    }
                ]
            };
        }

    }
}